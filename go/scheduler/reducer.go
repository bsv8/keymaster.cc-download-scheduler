package scheduler

import "math/big"

func ensureSeller(s *State, id string, online bool) *Seller {
	if s.Sellers[id] == nil {
		s.Sellers[id] = &Seller{ID: id, Online: online}
	}
	return s.Sellers[id]
}

// recordFailedAttempt accumulates already-transferred bytes and elapsed time.
// A zero-byte attempt stays at zero speed but is measured.
func recordFailedAttempt(seller *Seller, bytes, startedAt, at int64) {
	seller.BytesTotal += bytes
	elapsed := at - startedAt
	if elapsed < 1 {
		elapsed = 1
	}
	seller.TimeMsTotal += elapsed
	seller.Measured = true
	seller.LastAt = &at
}

func addContent(s *State, content []Content, reused []string) {
	for _, item := range content {
		identity(item.ID)
		if item.Kind != "seed" && item.Kind != "block" {
			fail("Invalid content")
		}
		integer(item.Bytes, 1)
		if previous, ok := s.Content.Get(item.ID); ok && (previous.Bytes != item.Bytes || previous.Kind != item.Kind) {
			fail("Conflicting content identity")
		}
		s.Content.Set(item)
	}
	seedCount := 0
	for _, item := range s.Content.Values() {
		if item.Kind == "seed" {
			seedCount++
		}
	}
	if seedCount > 1 {
		fail("Multiple Seed objects")
	}
	for _, id := range reused {
		if _, ok := s.Content.Get(id); !ok {
			fail("Unknown reused content")
		}
		for _, request := range s.Requests {
			if (request.State == "planned" || request.State == "pending" || request.State == "unresolved") && containsString(request.ContentIDs, id) {
				fail("Reusing unresolved content")
			}
		}
		if _, ok := s.Completed[id]; !ok {
			s.Completed[id] = "reused"
		}
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func boolValue(value *bool) bool { return value != nil && *value }

func intValue(value *int64, fallback int64) int64 {
	if value == nil {
		return fallback
	}
	return *value
}

func reduce(s *State, event Event) {
	switch event.Type {
	case "start", "resume":
		if s.Intent != "cancel" {
			s.Intent = "run"
			if event.Type == "resume" && s.QuoteDiscovery != nil && s.QuoteDiscovery.PendingCommandID == nil {
				s.QuoteDiscovery.Requested = false
				s.QuoteDiscovery.Failed = false
			}
		}
	case "quote-source":
		if event.Enabled == nil {
			fail("Missing quote source capability")
		}
		if s.QuoteDiscovery == nil {
			s.QuoteDiscovery = &QuoteDiscovery{}
		}
		s.QuoteDiscovery.Enabled = *event.Enabled
	case "quotes-requested", "quotes-request-failed":
		if d := s.QuoteDiscovery; d != nil && d.PendingCommandID != nil && *d.PendingCommandID == event.CommandID {
			d.PendingCommandID = nil
			d.Failed = event.Type == "quotes-request-failed"
			if d.Failed {
				d.Armed = false
			}
		}
	case "pause":
		if s.Intent != "cancel" {
			s.Intent = "pause"
		}
	case "cancel":
		s.Intent = "cancel"
	case "tick":
		// Wake-up only.
	case "limits":
		if event.MaxBlockPrice != nil {
			sats(*event.MaxBlockPrice)
			s.Config.MaxBlockPrice = *event.MaxBlockPrice
		}
		if event.BaseSeats != nil {
			integer(*event.BaseSeats, 1)
			s.Config.BaseSeats = *event.BaseSeats
		}
		if event.FloatingSeats != nil {
			integer(*event.FloatingSeats, 1)
			s.Config.FloatingSeats = *event.FloatingSeats
		}
	case "slider":
		sats(event.Value)
		if event.Slider != "price" {
			fail("Invalid slider")
		}
		value := event.Value
		s.Price = Slider{Mode: "manual", ManualValue: &value}
	case "automatic":
		if event.Slider != "price" {
			fail("Invalid slider")
		}
		s.Price.Mode = "auto"
	case "manifest":
		addContent(s, event.Content, event.Reused)
		s.ManifestKnown = true
	case "quote":
		if event.Quote == nil {
			fail("invalid quote")
		}
		validateQuote(*event.Quote)
		quote := cloneQuote(*event.Quote)
		seller := ensureSeller(s, quote.SellerID, true)
		if seller.Quote == nil || quote.Version > seller.Quote.Version {
			seller.Quote = &quote
		}
	case "seller":
		identity(event.SellerID)
		ensureSeller(s, event.SellerID, false).Online = boolValue(event.Online)
	case "wallet":
		if event.Revision == nil {
			fail("Invalid integer quantity")
		}
		integer(*event.Revision, 0)
		sats(event.Available)
		if *event.Revision > s.Wallet.Revision {
			s.Wallet = Wallet{
				Revision:          *event.Revision,
				Available:         event.Available,
				ReflectedCommands: append([]string{}, event.ReflectedCommands...),
			}
		}
	case "fees":
		if event.Fees == nil {
			fail("invalid fee contract")
		}
		validateFees(*event.Fees)
		pool := s.Pools[event.PoolID]
		if pool == nil {
			fail("Unknown fee contract")
		}
		if event.Fees.Version > pool.Fees.Version {
			pool.Fees = *event.Fees
		}
	case "pool-available":
		identity(event.PoolID)
		identity(event.SellerID)
		identity(event.SessionID)
		sats(event.Amount)
		sats(event.Committed)
		if event.Fees == nil {
			fail("invalid fee contract")
		}
		validateFees(*event.Fees)
		if sats(event.Committed).Cmp(sats(event.Amount)) > 0 {
			fail("Corrupt pool commitment")
		}
		if old := s.Pools[event.PoolID]; old != nil {
			if old.SellerID != event.SellerID || old.SessionID != event.SessionID || old.Amount != event.Amount || old.Committed != event.Committed {
				fail("Conflicting pool observation")
			}
			break
		}
		ensureSeller(s, event.SellerID, true)
		s.Pools[event.PoolID] = &Pool{ID: event.PoolID, TaskID: s.TaskID, SellerID: event.SellerID, SessionID: event.SessionID,
			OpeningFee: "0", Fees: *event.Fees, Amount: event.Amount, Committed: event.Committed, Funding: "open", Scheduling: "idle",
			OpeningObserved: true, WalletRevisionAtIntent: s.Wallet.Revision}
	case "opened":
		pool := s.Pools[event.PoolID]
		if pool == nil || pool.OpenCommandID != event.CommandID {
			fail("Uncorrelated opening")
		}
		if pool.OpeningObserved {
			break
		}
		if pool.Funding != "opening" && pool.Funding != "problem" {
			break
		}
		pool.OpeningObserved = true
		s.Spent = addSats(s.Spent, pool.OpeningFee)
		if pool.Funding == "opening" {
			pool.Funding = "open"
		}
	case "open-failed":
		pool := s.Pools[event.PoolID]
		if pool == nil || pool.OpenCommandID != event.CommandID {
			fail("Uncorrelated failure")
		}
		if pool.OpeningObserved || (pool.Funding != "opening" && pool.Funding != "problem") {
			break
		}
		if boolValue(event.Released) {
			pool.Funding = "failed"
		} else {
			pool.Funding = "problem"
		}
		if pool.RequestID != nil {
			work := s.Requests[*pool.RequestID]
			if work != nil && work.State == "planned" {
				work.State = "rejected"
				pool.RequestID = nil
			}
		}
		pool.Scheduling = "retired"
	case "unknown":
		pool := s.Pools[event.PoolID]
		if pool == nil {
			fail("Unknown pool result")
		}
		var request *Request
		for _, candidate := range s.Requests {
			if candidate.PoolID == pool.ID && candidate.CommandID == event.CommandID {
				request = candidate
				break
			}
		}
		if request != nil && (request.State == "settled" || request.State == "rejected") && event.CommandID != pool.OpenCommandID {
			break
		}
		if event.CommandID == pool.OpenCommandID && pool.OpeningObserved {
			break
		}
		correlated := event.CommandID == pool.OpenCommandID ||
			(pool.CloseCommandID != nil && event.CommandID == *pool.CloseCommandID) ||
			(request != nil && event.CommandID == request.CommandID)
		if !correlated {
			fail("Uncorrelated unknown result")
		}
		if pool.Funding == "closed" || pool.Funding == "failed" || pool.Funding == "problem" {
			break
		}
		if request != nil && request.State == "planned" {
			request.State = "rejected"
			pool.RequestID = nil
		} else if request != nil {
			request.State = "unresolved"
		}
		pool.Funding = "problem"
		pool.Scheduling = "retired"
	case "progress":
		identity(event.RequestID)
		request := s.Requests[event.RequestID]
		if request == nil || request.State != "pending" {
			break
		}
		if event.Bytes == nil {
			fail("Invalid integer quantity")
		}
		integer(*event.Bytes, 0)
		var size int64
		for _, id := range request.ContentIDs {
			item, _ := s.Content.Get(id)
			size += item.Bytes
		}
		if *event.Bytes > size {
			fail("Impossible transfer progress")
		}
		if *event.Bytes > request.TransferredBytes {
			request.TransferredBytes = *event.Bytes
			request.LastProgressAt = s.Now
		}
	case "delivery":
		identity(event.RequestID)
		request := s.Requests[event.RequestID]
		if request == nil {
			fail("Unknown delivery request")
		}
		if request.State == "settled" {
			break
		}
		if request.State != "pending" && request.State != "unresolved" {
			fail("Delivery without outstanding purchase authorization")
		}
		pool := s.Pools[request.PoolID]
		if pool.Funding == "closed" || pool.Funding == "failed" {
			fail("Delivery after pool settlement")
		}
		integer(event.StartedAt, 0)
		integer(event.EndedAt, event.StartedAt+1)
		if event.EndedAt > s.Now {
			fail("Future delivery")
		}
		seen := make(map[string]bool, len(event.Accepted))
		for _, id := range event.Accepted {
			if seen[id] || !containsString(request.ContentIDs, id) {
				fail("Invalid accepted content")
			}
			seen[id] = true
		}
		expected := big.NewInt(0)
		for _, id := range event.Accepted {
			expected.Add(expected, sats(request.Prices[id]))
		}
		if sats(event.Paid).Cmp(expected) != 0 {
			fail("Payment differs from authorization")
		}
		committed := sats(pool.Committed)
		committed.Add(committed, expected)
		if committed.Cmp(sats(pool.Amount)) > 0 {
			fail("Pool overspend")
		}
		pool.Committed = committed.String()
		for _, id := range event.Accepted {
			item, _ := s.Content.Get(id)
			if item.Kind == "block" {
				pool.PurchasedBlocks++
			}
		}
		s.Spent = addSats(s.Spent, expected.String())
		request.State = "settled"
		pool.RequestID = nil
		for _, id := range event.Accepted {
			s.Completed[id] = "purchased"
		}
		seller := s.Sellers[pool.SellerID]
		var acceptedBytes int64
		for _, id := range event.Accepted {
			item, _ := s.Content.Get(id)
			if item.Kind == "block" {
				acceptedBytes += item.Bytes
			}
		}
		if len(event.Accepted) == 0 {
			seller.Blacklisted = true
			seller.FailureCount++
			recordFailedAttempt(seller, 0, event.StartedAt, event.EndedAt)
		} else if acceptedBytes > 0 {
			seller.BytesTotal += acceptedBytes
			seller.TimeMsTotal += event.EndedAt - event.StartedAt
			seller.Measured = true
			seller.LastAt = &event.EndedAt
		}
		if pool.Funding == "open" && pool.Scheduling != "draining" && pool.Scheduling != "retired" {
			pool.Scheduling = "serving"
		}
	case "request-rejected":
		request := s.Requests[event.RequestID]
		if request == nil || (request.State != "pending" && request.State != "unresolved") {
			break
		}
		pool := s.Pools[request.PoolID]
		if !boolValue(event.SafeToRetry) {
			request.State = "unresolved"
			pool.Funding = "problem"
			pool.Scheduling = "retired"
		} else {
			request.State = "rejected"
			pool.RequestID = nil
			if pool.Scheduling != "retired" {
				pool.Scheduling = "draining"
				reason := "request-rejected"
				pool.DrainReason = &reason
			}
		}
	case "closed":
		pool := s.Pools[event.PoolID]
		if pool == nil || pool.CloseCommandID == nil || *pool.CloseCommandID != event.CommandID || pool.RequestID != nil {
			fail("Uncorrelated or unsafe close")
		}
		if pool.Funding == "closed" {
			break
		}
		total := new(big.Int).Set(sats(event.Returned))
		total.Add(total, sats(event.Spent))
		total.Add(total, sats(pool.Committed))
		if total.Cmp(sats(pool.Amount)) != 0 {
			fail("Close money mismatch")
		}
		pool.Funding = "closed"
		pool.Scheduling = "retired"
		returned := event.Returned
		pool.Returned = &returned
		s.Spent = addSats(s.Spent, event.Spent)
	case "refund-available":
		pool := s.Pools[event.PoolID]
		if pool == nil || pool.Funding != "closed" {
			fail("Refund before close observation")
		}
		pool.RefundAvailable = true
	default:
		fail("Unknown scheduler event")
	}
}

func assertRequestPrices(s *State) {
	for _, request := range s.Requests {
		for _, id := range request.ContentIDs {
			item, _ := s.Content.Get(id)
			expected := price(request.Quote, item)
			if sats(request.Prices[id]).Cmp(expected) != 0 {
				fail("Corrupt request prices")
			}
		}
	}
}
