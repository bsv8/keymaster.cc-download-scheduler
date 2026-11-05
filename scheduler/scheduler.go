package scheduler

import (
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// CreateInput contains only explicit facts; the kernel has no I/O or defaults.
type CreateInput struct {
	TaskID        string    `json:"taskId"`
	SeedHash      string    `json:"seedHash"`
	Config        Config    `json:"config"`
	Content       []Content `json:"content"`
	ManifestKnown bool      `json:"manifestKnown"`
	Reused        []string  `json:"reused"`
}

func CreateTask(input CreateInput) (state State, err error) {
	defer recoverTo(&err)
	identity(input.TaskID)
	identity(input.SeedHash)
	validateConfig(input.Config)
	state = State{Version: 1, TaskID: input.TaskID, SeedHash: input.SeedHash, Config: input.Config, Intent: "ready",
		Price: Slider{Mode: "auto"}, Seats: []string{}, ManifestKnown: input.ManifestKnown, Content: newContentStore(),
		Completed: map[string]string{}, Sellers: map[string]*Seller{}, Pools: map[string]*Pool{}, Requests: map[string]*Request{},
		Spent: "0", SeenEvents: map[string]bool{}}
	addContent(&state, input.Content, input.Reused)
	return state, nil
}

func RestoreTask(snapshot State) (state State, err error) {
	defer recoverTo(&err)
	state, err = cloneState(snapshot)
	if err != nil {
		return State{}, err
	}
	s := &state
	if s.Version != 1 || s.TaskID == "" || s.SeedHash == "" {
		fail("Unsupported task snapshot")
	}
	validateConfig(s.Config)
	integer(s.Now, 0)
	integer(s.Revision, 0)
	integer(s.Sequence, 0)
	identity(s.TaskID)
	identity(s.SeedHash)
	if s.Intent != "ready" && s.Intent != "run" && s.Intent != "pause" && s.Intent != "cancel" {
		fail("Invalid snapshot intent")
	}
	sats(s.Spent)
	if s.QuoteDiscovery != nil && s.QuoteDiscovery.PendingCommandID != nil {
		identity(*s.QuoteDiscovery.PendingCommandID)
	}
	if s.Failure != nil {
		if s.Failure.Code != "insufficient-funds" || s.Sellers[s.Failure.SellerID] == nil {
			fail("Invalid task failure")
		}
		sats(s.Failure.Required)
	}
	if s.Price.Mode != "auto" && s.Price.Mode != "manual" {
		fail("Invalid snapshot slider")
	}
	if s.Price.ManualValue != nil {
		sats(*s.Price.ManualValue)
	}
	if s.Price.Mode == "manual" && s.Price.ManualValue == nil {
		fail("Missing manual target")
	}
	if s.Seats == nil {
		fail("Invalid snapshot seats")
	}
	for _, id := range s.Seats {
		identity(id)
		if s.Sellers[id] == nil {
			fail("Unknown seat seller")
		}
	}
	for _, item := range s.Content.Values() {
		if item.ID == "" {
			fail("Content key mismatch")
		}
	}
	addContent(s, s.Content.Values(), nil)
	for id := range s.Completed {
		if _, ok := s.Content.Get(id); !ok {
			fail("Unknown completed content")
		}
	}
	for id, seller := range s.Sellers {
		identity(id)
		if seller.ID != id {
			fail("Seller key mismatch")
		}
		if seller.Quote != nil {
			validateQuote(*seller.Quote)
			if seller.Quote.SellerID != id {
				fail("Quote seller mismatch")
			}
		}
		integer(seller.FailureCount, 0)
		integer(seller.BytesTotal, 0)
		integer(seller.TimeMsTotal, 0)
		if seller.Measured && seller.TimeMsTotal <= 0 {
			fail("Measured seller without recorded time")
		}
		if seller.LastAt != nil {
			integer(*seller.LastAt, 0)
		}
	}
	for _, p := range s.Pools {
		if p.Quote != nil {
			validateQuote(*p.Quote)
		}
		if p.OpeningFee == "" {
			if p.Quote != nil {
				p.OpeningFee = p.Quote.Fees.Opening
			} else {
				p.OpeningFee = "0"
			}
		}
		sats(p.OpeningFee)
		validateFees(p.Fees)
		if s.Sellers[p.SellerID] == nil || (p.Quote != nil && p.Quote.SellerID != p.SellerID) {
			fail("Missing pool seller")
		}
		if !slices.Contains([]string{"opening", "open", "closing", "closed", "failed", "problem"}, p.Funding) {
			fail("Invalid funding state")
		}
		integer(p.BlockCapacity, 0)
		integer(p.PurchasedBlocks, 0)
		sats(p.Amount)
		sats(p.Committed)
		if sats(p.Committed).Cmp(sats(p.Amount)) > 0 {
			fail("Corrupt pool commitment")
		}
		if p.RequestID != nil && s.Requests[*p.RequestID] == nil {
			fail("Missing unresolved request")
		}
	}
	claims := map[string]bool{}
	for _, r := range s.Requests {
		p := s.Pools[r.PoolID]
		if p == nil {
			fail("Orphan request")
		}
		if r.Quote.ID == "" {
			if p.Quote == nil {
				fail("Missing purchase quote evidence")
			}
			r.Quote = cloneQuote(*p.Quote)
		}
		validateQuote(r.Quote)
		seen := map[string]bool{}
		for _, id := range r.ContentIDs {
			if _, ok := s.Content.Get(id); !ok {
				fail("Orphan request")
			}
			if seen[id] {
				fail("Duplicate request content")
			}
			seen[id] = true
		}
		if r.State == "planned" || r.State == "pending" || r.State == "unresolved" {
			if p.RequestID == nil || *p.RequestID != r.ID {
				fail("Request ownership mismatch")
			}
			for _, id := range r.ContentIDs {
				if claims[id] {
					fail("Duplicate outstanding content")
				}
				if _, ok := s.Completed[id]; ok {
					fail("Duplicate outstanding content")
				}
				claims[id] = true
			}
		}
	}
	assertRequestPrices(s)
	return state, nil
}

func Step(previous State, event Event) (result Result, err error) {
	defer debugStep(previous, event, &result, &err)()
	defer recoverTo(&err)
	identity(event.EventID)
	if event.TaskID != previous.TaskID || event.EventID == "" {
		fail("Wrong task event")
	}
	integer(event.ReceivedAt, 0)
	integer(event.OccurredAt, 0)
	if event.OccurredAt > event.ReceivedAt {
		fail("Event received before occurrence")
	}
	if previous.SeenEvents[event.EventID] {
		return Result{State: previous, Commands: []Command{}, View: view(&previous), NextWakeAt: nextWakeAt(&previous)}, nil
	}
	if event.ReceivedAt < previous.Now {
		fail("Receive clock moved backwards")
	}
	state, e := cloneState(previous)
	if e != nil {
		return Result{}, e
	}
	s := &state
	s.Now = event.ReceivedAt
	s.Revision++
	s.SeenEvents[event.EventID] = true
	reviewed := ""
	if event.Type == "delivery" {
		if r := previous.Requests[event.RequestID]; r != nil && r.State != "settled" {
			if p := previous.Pools[r.PoolID]; p != nil {
				reviewed = p.SellerID
			}
		}
	}
	reduce(s, event)
	commands := plan(s, reviewed)
	return Result{State: *s, Commands: commands, View: view(s), NextWakeAt: nextWakeAt(s)}, nil
}
func NextWakeAt(s State) *int64 { return nextWakeAt(&s) }
func ProjectView(s State) View  { return view(&s) }
func nextWakeAt(s *State) *int64 {
	times := []int64{}
	for _, seller := range s.Sellers {
		if seller.Quote != nil && seller.Quote.ExpiresAt > s.Now {
			times = append(times, seller.Quote.ExpiresAt)
		}
	}
	for _, p := range sortedPools(s) {
		if p.RequestID != nil {
			r := s.Requests[*p.RequestID]
			if r != nil && r.State == "pending" {
				times = append(times, r.LastProgressAt+s.Config.RequestTimeoutMs)
			}
		}
	}
	var at *int64
	for _, t := range times {
		if t > s.Now && (at == nil || t < *at) {
			value := t
			at = &value
		}
	}
	return at
}

func workCost(q Quote, items []Content) *big.Int {
	total := big.NewInt(0)
	for _, item := range items {
		total.Add(total, price(q, item))
	}
	return total
}
func workRequired(q Quote, fees Fees, items []Content) *big.Int {
	return new(big.Int).Add(workCost(q, items), reserve(fees, int64(len(items))))
}
func dispatchWork(s *State, p *Pool, r *Request, commands *[]Command) {
	r.State = "pending"
	r.StartedAt = s.Now
	r.LastProgressAt = s.Now
	reason := "download"
	first, _ := s.Content.Get(r.ContentIDs[0])
	if first.Kind == "seed" {
		reason = "seed-first"
	}
	c := base(s, reason)
	c.Type = "download"
	c.PoolID = p.ID
	c.RequestID = r.ID
	c.ContentIDs = append([]string{}, r.ContentIDs...)
	q := cloneQuote(r.Quote)
	c.Quote = &q
	c.Prices = map[string]Sats{}
	total := big.NewInt(0)
	for id, v := range r.Prices {
		c.Prices[id] = v
		total.Add(total, sats(v))
	}
	c.MaxPayment = total.String()
	c.PriceLimit = effectivePrice(s).String()
	v := p.Fees.Version
	c.FeeVersion = &v
	r.CommandID = c.CommandID
	p.RequestID = &r.ID
	p.Scheduling = "serving"
	*commands = append(*commands, c)
}

// plan assigns exclusive work before preparing funding. Completion of one
// request reviews only that seller; no global round or pool-lifetime block cap.
func plan(s *State, reviewed string) []Command {
	commands := []Command{}
	for _, r := range sortedRequests(s) {
		if r.State != "pending" || s.Now < r.LastProgressAt+s.Config.RequestTimeoutMs {
			continue
		}
		p := s.Pools[r.PoolID]
		r.State = "unresolved"
		recordFailedAttempt(s.Sellers[p.SellerID], r.TransferredBytes, r.StartedAt, s.Now)
		drain(s, p, &commands, "request-timeout")
		p.Funding = "problem"
		p.Scheduling = "retired"
	}
	_, quotes, _ := recommendations(s)
	if s.QuoteDiscovery != nil && len(validQuotes(s)) > 0 {
		s.QuoteDiscovery.Armed = true
		s.QuoteDiscovery.Failed = false
	}
	complete := s.ManifestKnown && len(pendingContent(s)) == 0
	enabled := s.Intent == "run" && s.Failure == nil && !complete
	awaiting := !s.ManifestKnown && len(pendingContent(s)) == 0
	qualified := []Quote{}
	if enabled {
		qualified = quotes
	}
	ids := map[string]bool{}
	for _, q := range qualified {
		ids[q.SellerID] = true
	}
	desired := newOrderedSet()
	for _, id := range s.Seats {
		if awaiting || ids[id] {
			desired.add(id)
		}
	}
	trimmed := map[string]bool{}
	order := desired.list()
	sort.SliceStable(order, func(i, j int) bool { return bestSeatFirst(s)(order[i], order[j]) < 0 })
	kept, unmeasured := int64(0), int64(0)
	for _, id := range order {
		measured := hasArchive(s, id)
		if kept >= seatCap(s) || (!measured && unmeasured >= unmeasuredCap(s)) {
			desired.delete(id)
			trimmed[id] = true
		} else {
			kept++
			if !measured {
				unmeasured++
			}
		}
	}
	if enabled && reviewed != "" {
		reviewSeats(s, []string{reviewed}, desired, qualified)
	}
	if enabled && !awaiting {
		measured := []Quote{}
		for _, q := range qualified {
			if !desired.has(q.SellerID) && !trimmed[q.SellerID] && hasArchive(s, q.SellerID) {
				measured = append(measured, q)
			}
		}
		sort.SliceStable(measured, func(i, j int) bool { return speedBefore(s, measured[i].SellerID, measured[j].SellerID) })
		for _, q := range measured {
			if int64(desired.len()) >= seatCap(s) {
				break
			}
			desired.add(q.SellerID)
		}
		newcomers := []string{}
		for _, q := range qualified {
			if !desired.has(q.SellerID) && !trimmed[q.SellerID] && !hasArchive(s, q.SellerID) {
				newcomers = append(newcomers, q.SellerID)
			}
		}
		unmeasured = 0
		for _, id := range desired.list() {
			if !hasArchive(s, id) {
				unmeasured++
			}
		}
		for int64(desired.len()) < seatCap(s) && unmeasured < unmeasuredCap(s) && len(newcomers) > 0 {
			id := pickRandom(s, newcomers)
			newcomers = removeID(newcomers, id)
			desired.add(id)
			unmeasured++
		}
	}
	s.Seats = desired.list()
	for _, p := range sortedPools(s) {
		if !isLive(p) {
			continue
		}
		exit := ""
		if !enabled {
			if s.Failure != nil {
				exit = s.Failure.Code
			} else if complete {
				exit = "content-complete"
			} else {
				exit = s.Intent
			}
		} else if !awaiting && !desired.has(p.SellerID) {
			exit = "strategy-change"
		}
		if exit == "" || (s.Intent == "ready" && s.Failure == nil && !complete) {
			continue
		}
		if p.RequestID != nil {
			r := s.Requests[*p.RequestID]
			if r != nil && r.State == "planned" && (s.Failure == nil || s.Intent != "run" || complete) {
				r.State = "rejected"
				p.RequestID = nil
			}
		}
		drain(s, p, &commands, exit)
	}
	// 已持久化的分配继续；新分配与既有工作的执行分开。
	if s.Intent == "run" && !complete {
		for _, p := range sortedPools(s) {
			if p.Funding != "open" || p.RequestID == nil {
				continue
			}
			r := s.Requests[*p.RequestID]
			if r.State != "planned" {
				continue
			}
			items := []Content{}
			for _, cid := range r.ContentIDs {
				item, _ := s.Content.Get(cid)
				items = append(items, item)
			}
			if sats(r.Quote.BlockPrice).Cmp(effectivePrice(s)) > 0 || r.Quote.ExpiresAt <= s.Now || workRequired(r.Quote, p.Fees, items).Cmp(new(big.Int).Sub(sats(p.Amount), sats(p.Committed))) > 0 {
				r.State = "rejected"
				p.RequestID = nil
				drain(s, p, &commands, "work-invalidated")
			} else {
				dispatchWork(s, p, r, &commands)
			}
		}
	}
	claimed := map[string]bool{}
	for _, r := range sortedRequests(s) {
		if r.State == "planned" || r.State == "pending" || r.State == "unresolved" {
			for _, id := range r.ContentIDs {
				claimed[id] = true
			}
		}
	}
	measuredOrder := []string{}
	remaining := []string{}
	for _, id := range desired.list() {
		if hasArchive(s, id) {
			measuredOrder = append(measuredOrder, id)
		} else {
			remaining = append(remaining, id)
		}
	}
	sort.SliceStable(measuredOrder, func(i, j int) bool { return speedBefore(s, measuredOrder[i], measuredOrder[j]) })
	randomOrder := []string{}
	for len(remaining) > 0 {
		id := pickRandom(s, remaining)
		remaining = removeID(remaining, id)
		randomOrder = append(randomOrder, id)
	}
	if enabled && !awaiting {
		for _, id := range append(measuredOrder, randomOrder...) {
			if s.Failure != nil {
				break
			}
			var p *Pool
			for _, candidate := range sortedPools(s) {
				if candidate.SellerID == id && isLive(candidate) && candidate.Scheduling != "draining" && candidate.Scheduling != "retired" {
					p = candidate
					break
				}
			}
			var old *Request
			if p != nil && p.RequestID != nil {
				old = s.Requests[*p.RequestID]
			}
			if old != nil {
				continue
			}
			if p != nil && p.Funding != "open" {
				continue
			}
			var q *Quote
			for index := range qualified {
				if qualified[index].SellerID == id {
					q = &qualified[index]
					break
				}
			}
			if q == nil {
				continue
			}
			items := []Content{}
			for _, item := range availableContent(s, *q) {
				if !claimed[item.ID] {
					items = append(items, item)
				}
			}
			if len(items) == 0 {
				continue
			}
			limit := min(q.MaxBlocks, s.Config.PoolBlocks)
			if items[0].Kind == "seed" {
				limit = 1
			}
			if int64(len(items)) > limit {
				items = items[:limit]
			}
			if p != nil {
				affordable := append([]Content{}, items...)
				for len(affordable) > 0 && workRequired(*q, p.Fees, affordable).Cmp(new(big.Int).Sub(sats(p.Amount), sats(p.Committed))) > 0 {
					affordable = affordable[:len(affordable)-1]
				}
				if len(affordable) > 0 {
					items = affordable
				} else {
					drain(s, p, &commands, "pool-exhausted")
					p = nil
				}
			}
			requestID := nextID(s, "request")
			poolID := ""
			if p != nil {
				poolID = p.ID
			} else {
				poolID = nextID(s, "pool")
			}
			prices := map[string]Sats{}
			contentIDs := []string{}
			count := int64(0)
			for _, item := range items {
				prices[item.ID] = price(*q, item).String()
				contentIDs = append(contentIDs, item.ID)
				claimed[item.ID] = true
				if item.Kind == "block" {
					count++
				}
			}
			r := &Request{ID: requestID, CommandID: "", PoolID: poolID, Quote: cloneQuote(*q), ContentIDs: contentIDs, Prices: prices, StartedAt: s.Now, LastProgressAt: s.Now, State: "planned"}
			s.Requests[requestID] = r
			if p != nil {
				dispatchWork(s, p, r, &commands)
				continue
			}
			budget := workCost(*q, items)
			reserved := reserve(q.Fees, int64(len(items)))
			c := base(s, "work-assigned")
			c.Type = "open"
			c.PoolID = poolID
			c.SellerID = id
			c.SessionID = q.SessionID
			qc := cloneQuote(*q)
			c.Quote = &qc
			c.Amount = new(big.Int).Add(budget, reserved).String()
			c.ContentBudget = budget.String()
			c.Reserve = reserved.String()
			c.OpeningFee = q.Fees.Opening
			c.BlockCapacity = &count
			c.RequestID = requestID
			c.ContentIDs = append([]string{}, contentIDs...)
			r.CommandID = c.CommandID
			s.Pools[poolID] = &Pool{ID: poolID, TaskID: s.TaskID, SellerID: id, SessionID: q.SessionID, Quote: &qc, OpeningFee: q.Fees.Opening, Fees: q.Fees, Amount: c.Amount, Committed: "0", BlockCapacity: count,
				Funding: "opening", Scheduling: "idle", OpenCommandID: c.CommandID, RequestID: &r.ID}
			commands = append(commands, c)
		}
	}
	if d := s.QuoteDiscovery; s.Intent == "run" && s.Failure == nil && !complete && !awaiting && d != nil && d.Enabled && d.PendingCommandID == nil && (!d.Requested || d.Armed) && len(validQuotes(s)) == 0 {
		for _, item := range pendingContent(s) {
			if claimed[item.ID] {
				continue
			}
			c := base(s, "quotes-unavailable")
			c.Type = "discover"
			d.PendingCommandID = &c.CommandID
			d.Requested = true
			d.Armed = false
			commands = append(commands, c)
			break
		}
	}
	if s.Failure != nil {
		for _, p := range sortedPools(s) {
			if isLive(p) {
				drain(s, p, &commands, s.Failure.Code)
			}
		}
	}
	for _, p := range sortedPools(s) {
		if p.Funding != "open" || p.RequestID != nil || p.Scheduling != "draining" {
			continue
		}
		reason := "drain-complete"
		if p.DrainReason != nil {
			reason = *p.DrainReason
		}
		c := base(s, reason)
		c.Type = "close"
		c.PoolID = p.ID
		c.Committed = p.Committed
		p.Funding = "closing"
		p.CloseCommandID = &c.CommandID
		commands = append(commands, c)
	}
	return commands
}

func validateConfig(c Config) {
	sats(c.MaxBlockPrice)
	integer(c.BaseSeats, 1)
	integer(c.FloatingSeats, 1)
	integer(c.PoolBlocks, 1)
	integer(c.RequestTimeoutMs, 1)
}
func isLive(p *Pool) bool {
	return p.Funding != "closed" && p.Funding != "failed" && p.Funding != "problem"
}
func nextID(s *State, kind string) string {
	s.Sequence++
	return fmt.Sprintf("%s/%s/%d", s.TaskID, kind, s.Sequence)
}
func base(s *State, reason string) Command {
	return Command{CommandID: nextID(s, "command"), TaskID: s.TaskID, Revision: s.Revision, Reason: reason}
}
func drain(s *State, p *Pool, commands *[]Command, reason string) {
	if p.Scheduling == "draining" || p.Scheduling == "retired" {
		return
	}
	p.Scheduling = "draining"
	p.DrainReason = &reason
	c := base(s, reason)
	c.Type = "drain"
	c.PoolID = p.ID
	*commands = append(*commands, c)
}
func hasInFlight(s *State, id string) bool {
	for _, p := range sortedPools(s) {
		if p.SellerID == id && p.RequestID != nil {
			r := s.Requests[*p.RequestID]
			if r != nil && (r.State == "pending" || r.State == "unresolved") {
				return true
			}
		}
	}
	return false
}
func speedBefore(s *State, a, b string) bool {
	av, bv := 0.0, 0.0
	if v := sellerSpeed(s, a); v != nil {
		av = *v
	}
	if v := sellerSpeed(s, b); v != nil {
		bv = *v
	}
	if av != bv {
		return av > bv
	}
	return compareStrings(a, b) < 0
}
func bestSeatFirst(s *State) func(a, b string) int {
	return func(a, b string) int {
		if hasInFlight(s, a) != hasInFlight(s, b) {
			if hasInFlight(s, a) {
				return -1
			}
			return 1
		}
		if hasArchive(s, a) != hasArchive(s, b) {
			if hasArchive(s, a) {
				return -1
			}
			return 1
		}
		if speedBefore(s, a, b) {
			return -1
		}
		if speedBefore(s, b, a) {
			return 1
		}
		return 0
	}
}
func reviewSeats(s *State, reviewed []string, desired *orderedSet, qualified []Quote) {
	for _, id := range reviewed {
		if !desired.has(id) || !hasArchive(s, id) || hasInFlight(s, id) {
			continue
		}
		ranked := []string{}
		for _, sid := range desired.list() {
			if hasArchive(s, sid) {
				ranked = append(ranked, sid)
			}
		}
		sort.SliceStable(ranked, func(i, j int) bool { return speedBefore(s, ranked[i], ranked[j]) })
		rank := slices.Index(ranked, id) + 1
		if int64(rank) <= s.Config.BaseSeats {
			continue
		}
		measured := []string{}
		newcomers := []string{}
		for _, q := range qualified {
			if desired.has(q.SellerID) {
				continue
			}
			if hasArchive(s, q.SellerID) {
				measured = append(measured, q.SellerID)
			} else {
				newcomers = append(newcomers, q.SellerID)
			}
		}
		sort.SliceStable(measured, func(i, j int) bool { return speedBefore(s, measured[i], measured[j]) })
		if len(measured) > 0 && *sellerSpeed(s, measured[0]) > *sellerSpeed(s, id) {
			desired.delete(id)
			desired.add(measured[0])
			continue
		}
		unmeasured := int64(0)
		for _, sid := range desired.list() {
			if !hasArchive(s, sid) {
				unmeasured++
			}
		}
		if len(newcomers) > 0 && unmeasured < s.Config.FloatingSeats {
			desired.delete(id)
			desired.add(pickRandom(s, newcomers))
		}
	}
}
func pickRandom(s *State, ids []string) string {
	sorted := append([]string{}, ids...)
	sort.Slice(sorted, func(i, j int) bool {
		return slices.Compare(utf16.Encode([]rune(sorted[i])), utf16.Encode([]rune(sorted[j]))) < 0
	})
	seed := fmt.Sprintf("%s|%d|%s", s.TaskID, s.Sequence, strings.Join(sorted, ","))
	hash := uint32(2166136261)
	for _, unit := range utf16.Encode([]rune(seed)) {
		hash ^= uint32(unit)
		hash *= 16777619
	}
	return sorted[int(hash%uint32(len(sorted)))]
}
func removeID(ids []string, id string) []string {
	for i, v := range ids {
		if v == id {
			return append(ids[:i], ids[i+1:]...)
		}
	}
	return ids
}
func cloneState(s State) (State, error) {
	encoded, err := json.Marshal(s)
	if err != nil {
		return State{}, err
	}
	var result State
	err = json.Unmarshal(encoded, &result)
	return result, err
}
func recoverTo(err *error) {
	if r := recover(); r != nil {
		if k, ok := r.(kernelPanic); ok {
			*err = k.err
			return
		}
		panic(r)
	}
}
func sortedPools(s *State) []*Pool {
	ids := []string{}
	for id := range s.Pools {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := idSequence(ids[i]), idSequence(ids[j])
		if a != b {
			return a < b
		}
		return ids[i] < ids[j]
	})
	result := []*Pool{}
	for _, id := range ids {
		result = append(result, s.Pools[id])
	}
	return result
}
func sortedRequests(s *State) []*Request {
	ids := []string{}
	for id := range s.Requests {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := idSequence(ids[i]), idSequence(ids[j])
		if a != b {
			return a < b
		}
		return ids[i] < ids[j]
	})
	result := []*Request{}
	for _, id := range ids {
		result = append(result, s.Requests[id])
	}
	return result
}
func idSequence(id string) int64 {
	i := strings.LastIndex(id, "/")
	if i < 0 {
		return 0
	}
	value, err := strconv.ParseInt(id[i+1:], 10, 64)
	if err != nil {
		return 0
	}
	return value
}
func compareStrings(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

type orderedSet struct {
	items []string
	set   map[string]bool
}

func newOrderedSet() *orderedSet { return &orderedSet{set: map[string]bool{}} }
func (o *orderedSet) add(id string) {
	if !o.set[id] {
		o.set[id] = true
		o.items = append(o.items, id)
	}
}
func (o *orderedSet) delete(id string) {
	if o.set[id] {
		delete(o.set, id)
		o.items = removeID(o.items, id)
	}
}
func (o *orderedSet) has(id string) bool { return o.set[id] }
func (o *orderedSet) len() int           { return len(o.items) }
func (o *orderedSet) list() []string     { return append([]string{}, o.items...) }
