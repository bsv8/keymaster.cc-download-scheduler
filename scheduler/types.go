// Package scheduler is the Go port of keymaster.cc-download-scheduler.
//
// The kernel is a pure state machine: createTask, step and restoreTask have no
// clock, network, wallet or storage side effects. State, commands and views are
// JSON-compatible and match the TypeScript SDK field-for-field.
package scheduler

import (
	"encoding/json"
	"errors"
)

// unsupportedSnapshot is the single error returned for any legacy or corrupt
// snapshot shape; no silent field dropping or migration is performed.
var errUnsupportedSnapshot = errors.New("Unsupported task snapshot")

// State decodes with legacy-marker rejection: the old format carried
// `manifestKnown`, a top-level `wallet` and a download `taskId`; all are
// rejected outright, and the new `manifest` field is required (it may be null).
func (s *State) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	for _, legacy := range []string{"manifestKnown", "wallet", "taskId"} {
		if _, ok := keys[legacy]; ok {
			return errUnsupportedSnapshot
		}
	}
	if _, ok := keys["manifest"]; !ok {
		return errUnsupportedSnapshot
	}
	type plain State
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*s = State(aux)
	return nil
}

// Pool rejects the obsolete walletRevisionAtIntent hint and the old
// download-level taskId; pool identity is fully covered by its own id.
func (p *Pool) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	if _, ok := keys["walletRevisionAtIntent"]; ok {
		return errUnsupportedSnapshot
	}
	if _, ok := keys["taskId"]; ok {
		return errUnsupportedSnapshot
	}
	type plain Pool
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*p = Pool(aux)
	return nil
}

// TaskFailure rejects the obsolete available hint.
func (f *TaskFailure) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	if _, ok := keys["available"]; ok {
		return errUnsupportedSnapshot
	}
	type plain TaskFailure
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*f = TaskFailure(aux)
	return nil
}

// Manifest accepts exactly the new field; anything else is rejected.
// blockHashes is required (it may be empty for a known-empty file, but a
// missing or null list means the snapshot shape is obsolete).
func (m *Manifest) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	raw, ok := keys["blockHashes"]
	if !ok || string(raw) == "null" {
		return errUnsupportedSnapshot
	}
	for key := range keys {
		switch key {
		case "blockHashes":
		default:
			return errUnsupportedSnapshot
		}
	}
	type plain Manifest
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*m = Manifest(aux)
	return nil
}

// Content rejects the obsolete bytes hint; content identity is hash-only.
func (c *Content) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	if _, ok := keys["bytes"]; ok {
		return errUnsupportedSnapshot
	}
	type plain Content
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*c = Content(aux)
	return nil
}

// Quote carries no custom decoding: the obsolete blockBytes hint is ignored
// at entry (matching the TypeScript strip) and never persisted; old snapshots
// are still rejected via the manifest shape.

// Sats is a canonical decimal integer string.
type Sats = string

// Content is one deductible unit (seed or block). Identity is hash-only;
// accepted byte counts are execution stats for speed, never identity.
type Content struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// Manifest is the complete ordered block list (duplicates allowed).
type Manifest struct {
	BlockHashes []string `json:"blockHashes"`
}

// Fees is the host-supplied fee contract.
type Fees struct {
	Version            int64 `json:"version"`
	Opening            Sats  `json:"opening"`
	Settlement         Sats  `json:"settlement"`
	ArbitrationBase    Sats  `json:"arbitrationBase"`
	ArbitrationPerItem Sats  `json:"arbitrationPerItem"`
}

// Quote is a verified seller quote. TailPrice quotes the manifest tail hash;
// when absent it falls back to BlockPrice.
type Quote struct {
	ID         string   `json:"id"`
	Version    int64    `json:"version"`
	SellerID   string   `json:"sellerId"`
	SessionID  string   `json:"sessionId"`
	ExpiresAt  int64    `json:"expiresAt"`
	BlockPrice Sats     `json:"blockPrice"`
	SeedPrice  Sats     `json:"seedPrice"`
	TailPrice  *Sats    `json:"tailPrice,omitempty"`
	MaxBlocks  int64    `json:"maxBlocks"`
	Fees       Fees     `json:"fees"`
	ContentIDs []string `json:"contentIds,omitzero"`
}

// Config is the explicit task configuration (no kernel defaults).
type Config struct {
	MaxBlockPrice    Sats  `json:"maxBlockPrice"`
	BaseSeats        int64 `json:"baseSeats"`
	FloatingSeats    int64 `json:"floatingSeats"`
	PoolBlocks       int64 `json:"poolBlocks"`
	RequestTimeoutMs int64 `json:"requestTimeoutMs"`
}

// Slider is the price slider state.
type Slider struct {
	Mode        string  `json:"mode"`
	ManualValue *string `json:"manualValue"`
}

// Seller is the per-seller cumulative profile.
type Seller struct {
	ID           string `json:"id"`
	Online       bool   `json:"online"`
	Quote        *Quote `json:"quote"`
	BytesTotal   int64  `json:"bytesTotal"`
	TimeMsTotal  int64  `json:"timeMsTotal"`
	Measured     bool   `json:"measured"`
	LastAt       *int64 `json:"lastAt"`
	Blacklisted  bool   `json:"blacklisted"`
	FailureCount int64  `json:"failureCount"`
}

// PoolFunding is the funding lifecycle of a fee pool.
type PoolFunding = string

// PoolScheduling is the scheduling lifecycle of a fee pool.
type PoolScheduling = string

// Pool is one seller's fee pool.
type Pool struct {
	ID              string         `json:"id"`
	SellerID        string         `json:"sellerId"`
	SessionID       string         `json:"sessionId"`
	Quote           *Quote         `json:"quote,omitempty"`
	OpeningFee      Sats           `json:"openingFee"`
	Fees            Fees           `json:"fees"`
	Amount          Sats           `json:"amount"`
	Committed       Sats           `json:"committed"`
	BlockCapacity   int64          `json:"blockCapacity"`
	PurchasedBlocks int64          `json:"purchasedBlocks"`
	Funding         PoolFunding    `json:"funding"`
	Scheduling      PoolScheduling `json:"scheduling"`
	OpenCommandID   string         `json:"openCommandId"`
	CloseCommandID  *string        `json:"closeCommandId"`
	RequestID       *string        `json:"requestId"`
	DrainReason     *string        `json:"drainReason"`
	Returned        *Sats          `json:"returned"`
	RefundAvailable bool           `json:"refundAvailable"`
	OpeningObserved bool           `json:"openingObserved"`
}

// TaskFailure is terminal for new work; existing obligations still settle.
type TaskFailure struct {
	Code     string `json:"code"`
	SellerID string `json:"sellerId"`
	Required Sats   `json:"required"`
}

// Request is one planned or dispatched content request.
type Request struct {
	Quote            Quote           `json:"quote"`
	ID               string          `json:"id"`
	CommandID        string          `json:"commandId"`
	PoolID           string          `json:"poolId"`
	ContentIDs       []string        `json:"contentIds"`
	Prices           map[string]Sats `json:"prices"`
	StartedAt        int64           `json:"startedAt"`
	LastProgressAt   int64           `json:"lastProgressAt"`
	TransferredBytes int64           `json:"transferredBytes"`
	State            string          `json:"state"`
}

// QuoteDiscovery 是报价查询端口事实与唯一查询意图；没有报价不循环重试。
type QuoteDiscovery struct {
	Enabled          bool    `json:"enabled"`
	Armed            bool    `json:"armed"`
	Requested        bool    `json:"requested"`
	Failed           bool    `json:"failed"`
	PendingCommandID *string `json:"pendingCommandId"`
}

// State is the complete kernel state (JSON-serializable, version 1).
type State struct {
	Version        int             `json:"version"`
	SeedHash       string          `json:"seedHash"`
	Revision       int64           `json:"revision"`
	Sequence       int64           `json:"sequence"`
	Now            int64           `json:"now"`
	Config         Config          `json:"config"`
	Intent         string          `json:"intent"`
	Failure        *TaskFailure    `json:"failure"`
	QuoteDiscovery *QuoteDiscovery `json:"quoteDiscovery,omitempty"`
	Price          Slider          `json:"price"`
	Seats          []string        `json:"seats"`
	// Manifest is the file structure; nil means the seed is not known yet.
	Manifest   *Manifest           `json:"manifest"`
	Content    contentStore        `json:"content"`
	Completed  map[string]string   `json:"completed"`
	Sellers    map[string]*Seller  `json:"sellers"`
	Pools      map[string]*Pool    `json:"pools"`
	Requests   map[string]*Request `json:"requests"`
	Spent      Sats                `json:"spent"`
	SeenEvents map[string]bool     `json:"seenEvents"`
}

// Event is one host fact applied to the kernel.
type Event struct {
	Type string `json:"type"`

	MaxBlockPrice     *Sats    `json:"maxBlockPrice,omitempty"`
	BaseSeats         *int64   `json:"baseSeats,omitempty"`
	FloatingSeats     *int64   `json:"floatingSeats,omitempty"`
	Slider            string   `json:"slider,omitempty"`
	Value             string   `json:"value,omitempty"`
	BlockHashes       []string `json:"blockHashes"`
	ReusedBlockHashes []string `json:"reusedBlockHashes,omitempty"`
	// reusedWasNull records an explicit JSON null for the optional reuse list,
	// which rejects like the TypeScript entry (only omission means unprovided).
	reusedWasNull      bool     `json:"-"`
	Quote              *Quote   `json:"quote,omitempty"`
	SellerID           string   `json:"sellerId,omitempty"`
	Online             *bool    `json:"online,omitempty"`
	Enabled            *bool    `json:"enabled,omitempty"`
	InsufficientFunds  bool     `json:"insufficientFunds,omitempty"`
	PoolID             string   `json:"poolId,omitempty"`
	SessionID          string   `json:"sessionId,omitempty"`
	Amount             Sats     `json:"amount,omitempty"`
	Committed          Sats     `json:"committed,omitempty"`
	Fees               *Fees    `json:"fees,omitempty"`
	CommandID          string   `json:"commandId,omitempty"`
	Released           *bool    `json:"released,omitempty"`
	RequestID          string   `json:"requestId,omitempty"`
	Bytes              *int64   `json:"bytes,omitempty"`
	Accepted           []string `json:"accepted,omitempty"`
	Paid               string   `json:"paid,omitempty"`
	AcceptedBlockBytes *int64   `json:"acceptedBlockBytes,omitempty"`
	StartedAt          int64    `json:"startedAt,omitempty"`
	EndedAt            int64    `json:"endedAt,omitempty"`
	SafeToRetry        *bool    `json:"safeToRetry,omitempty"`
	Returned           string   `json:"returned,omitempty"`
	Spent              string   `json:"spent,omitempty"`

	EventID    string `json:"eventId"`
	SeedHash   string `json:"seedHash"`
	OccurredAt int64  `json:"occurredAt"`
	ReceivedAt int64  `json:"receivedAt"`
}

// Command is one host execution intent.
type Command struct {
	CommandID string `json:"commandId"`
	SeedHash  string `json:"seedHash"`
	Revision  int64  `json:"revision"`
	Reason    string `json:"reason"`
	Type      string `json:"type"`

	PoolID        string          `json:"poolId,omitempty"`
	SellerID      string          `json:"sellerId,omitempty"`
	SessionID     string          `json:"sessionId,omitempty"`
	Quote         *Quote          `json:"quote,omitempty"`
	Amount        string          `json:"amount,omitempty"`
	ContentBudget string          `json:"contentBudget,omitempty"`
	Reserve       string          `json:"reserve,omitempty"`
	OpeningFee    string          `json:"openingFee,omitempty"`
	BlockCapacity *int64          `json:"blockCapacity,omitempty"`
	RequestID     string          `json:"requestId,omitempty"`
	ContentIDs    []string        `json:"contentIds,omitempty"`
	Prices        map[string]Sats `json:"prices,omitempty"`
	MaxPayment    string          `json:"maxPayment,omitempty"`
	PriceLimit    string          `json:"priceLimit,omitempty"`
	FeeVersion    *int64          `json:"feeVersion,omitempty"`
	Committed     string          `json:"committed,omitempty"`
}

// SliderView is the price slider projection.
type SliderView struct {
	Mode        string      `json:"mode"`
	ManualValue *string     `json:"manualValue"`
	Effective   string      `json:"effective"`
	Range       *PriceRange `json:"range"`
}

// PriceRange is the observed market range.
type PriceRange struct {
	Min string `json:"min"`
	Max string `json:"max"`
}

// SellerSpeedView is one seller's cumulative speed fact.
type SellerSpeedView struct {
	BytesPerSecond *float64 `json:"bytesPerSecond"`
	Measured       bool     `json:"measured"`
	BytesTotal     int64    `json:"bytesTotal"`
	TimeMsTotal    int64    `json:"timeMsTotal"`
	LastAt         *int64   `json:"lastAt"`
}

// View is the host/UI projection.
type View struct {
	SeedHash                  string                     `json:"seedHash"`
	Revision                  int64                      `json:"revision"`
	Failure                   *TaskFailure               `json:"failure"`
	Execution                 string                     `json:"execution"`
	Content                   string                     `json:"content"`
	Funds                     string                     `json:"funds"`
	Price                     SliderView                 `json:"price"`
	SellerSpeeds              map[string]SellerSpeedView `json:"sellerSpeeds"`
	ActualBytesPerSecond      float64                    `json:"actualBytesPerSecond"`
	SustainableBytesPerSecond float64                    `json:"sustainableBytesPerSecond"`
	Facts                     ViewFacts                  `json:"facts"`
	Completed                 int                        `json:"completed"`
	Total                     int                        `json:"total"`
	Reasons                   []string                   `json:"reasons"`
	Money                     ViewMoney                  `json:"money"`
	EstimatedRemainingContent *EstimatedContent          `json:"estimatedRemainingContent"`
}

// ViewFacts is the factual admission/in-flight summary.
type ViewFacts struct {
	Eligible           int `json:"eligible"`
	AboveCeiling       int `json:"aboveCeiling"`
	Measured           int `json:"measured"`
	UnmeasuredEligible int `json:"unmeasuredEligible"`
	ZeroSpeed          int `json:"zeroSpeed"`
	Blacklisted        int `json:"blacklisted"`
	InFlight           int `json:"inFlight"`
}

// ViewMoney is the money summary.
type ViewMoney struct {
	Spent               Sats `json:"spent"`
	Locked              Sats `json:"locked"`
	Committed           Sats `json:"committed"`
	PendingReturn       Sats `json:"pendingReturn"`
	ArbitrationReserved Sats `json:"arbitrationReserved"`
	SettlementReserved  Sats `json:"settlementReserved"`
}

// EstimatedContent is the quote-based remaining content estimate.
type EstimatedContent struct {
	Min string `json:"min"`
	Max string `json:"max"`
}

// Result is the step result.
type Result struct {
	State      State     `json:"state"`
	Commands   []Command `json:"commands"`
	View       View      `json:"view"`
	NextWakeAt *int64    `json:"nextWakeAt"`
}

// MarshalJSON preserves the omitted-vs-empty distinction: a nil Resume is
// dropped so seed-only inputs never encode `"resume": null`, while an
// explicitly empty ordered list survives the round-trip. An explicitly null
// reuse list round-trips as null so the rejection is preserved.
func (c CreateTaskInput) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		"seedHash": c.SeedHash,
	}
	// Preserve a legacy taskId marker through a JSON round-trip so the
	// rejection stays observable; it is never persisted or acted upon.
	if c.hadTaskID {
		out["taskId"] = true
	}
	if c.Resume != nil {
		resume := map[string]any{}
		if c.Resume.BlockHashes != nil {
			resume["blockHashes"] = append([]string{}, c.Resume.BlockHashes...)
		}
		if c.Resume.ReusedBlockHashes != nil {
			resume["reusedBlockHashes"] = append([]string{}, c.Resume.ReusedBlockHashes...)
		} else if c.Resume.reusedWasNull {
			resume["reusedBlockHashes"] = nil
		}
		out["resume"] = resume
	}
	return json.Marshal(out)
}

// UnmarshalJSON distinguishes omitted resume (unknown manifest) from explicit
// null (rejected like the TypeScript entry), and records a legacy taskId so
// CreateTask can reject it exactly like the TypeScript entry.
func (c *CreateTaskInput) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	type plain CreateTaskInput
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	if raw, ok := keys["resume"]; ok && string(raw) == "null" {
		aux.Resume = &CreateResume{}
	}
	if _, ok := keys["taskId"]; ok {
		aux.hadTaskID = true
	}
	*c = CreateTaskInput(aux)
	return nil
}

// CreateResume is a verified local seed plus its complete ordered block list.
type CreateResume struct {
	BlockHashes       []string `json:"blockHashes"`
	ReusedBlockHashes []string `json:"reusedBlockHashes,omitempty"`
	// reusedWasNull records an explicit JSON null for the optional reuse list.
	reusedWasNull bool `json:"-"`
}

// UnmarshalJSON records an explicit null reuse list so it rejects.
func (r *CreateResume) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	wasNull := false
	if raw, ok := keys["reusedBlockHashes"]; ok && string(raw) == "null" {
		wasNull = true
	}
	type plain CreateResume
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*r = CreateResume(aux)
	r.reusedWasNull = wasNull
	return nil
}

// UnmarshalJSON records an explicit null reuse list so manifest events reject.
func (e *Event) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	wasNull := false
	if raw, ok := keys["reusedBlockHashes"]; ok && string(raw) == "null" {
		wasNull = true
	}
	type plain Event
	var aux plain
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*e = Event(aux)
	e.reusedWasNull = wasNull
	return nil
}

// CreateTaskInput holds the explicit facts for a fresh task: only the seed
// hash (manifest unknown) or a verified resume. Providing resume asserts the
// local Seed is available and verified. A legacy taskId is never accepted;
// hadTaskID only carries the rejection through a JSON round-trip.
type CreateTaskInput struct {
	SeedHash string        `json:"seedHash"`
	Resume   *CreateResume `json:"resume,omitempty"`

	hadTaskID bool `json:"-"`
}
