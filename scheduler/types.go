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
// `manifestKnown` and a top-level `wallet`; both are rejected outright, and
// the new `manifest` field is required (it may be null).
func (s *State) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	for _, legacy := range []string{"manifestKnown", "wallet"} {
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

// Pool rejects the obsolete walletRevisionAtIntent hint.
func (p *Pool) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	if _, ok := keys["walletRevisionAtIntent"]; ok {
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

// Manifest accepts exactly the three new fields; anything else is rejected.
// All three fields are required: a missing fileBytes must not silently
// become 0 (which would mean "known empty file").
func (m *Manifest) UnmarshalJSON(data []byte) error {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	for _, required := range []string{"fileBytes", "blockBytes", "blockHashes"} {
		raw, ok := keys[required]
		if !ok || string(raw) == "null" {
			return errUnsupportedSnapshot
		}
	}
	for key := range keys {
		switch key {
		case "fileBytes", "blockBytes", "blockHashes":
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

// Sats is a canonical decimal integer string.
type Sats = string

// Content is one deductible unit (seed or block). Seeds carry no Bytes
// (the seed size is unknown; no upper-bound check) — blocks carry their
// derived byte length.
type Content struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Bytes *int64 `json:"bytes,omitempty"`
}

// Manifest is the complete ordered block list (duplicates allowed) and the
// fixed block size plus tail derivation inputs.
type Manifest struct {
	FileBytes   int64    `json:"fileBytes"`
	BlockBytes  int64    `json:"blockBytes"`
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

// Quote is a verified seller quote.
type Quote struct {
	ID         string   `json:"id"`
	Version    int64    `json:"version"`
	SellerID   string   `json:"sellerId"`
	SessionID  string   `json:"sessionId"`
	ExpiresAt  int64    `json:"expiresAt"`
	BlockPrice Sats     `json:"blockPrice"`
	SeedPrice  Sats     `json:"seedPrice"`
	BlockBytes int64    `json:"blockBytes"`
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
	TaskID          string         `json:"taskId"`
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
	Version        int                 `json:"version"`
	TaskID         string              `json:"taskId"`
	SeedHash       string              `json:"seedHash"`
	Revision       int64               `json:"revision"`
	Sequence       int64               `json:"sequence"`
	Now            int64               `json:"now"`
	Config         Config              `json:"config"`
	Intent         string              `json:"intent"`
	Failure        *TaskFailure        `json:"failure"`
	QuoteDiscovery *QuoteDiscovery     `json:"quoteDiscovery,omitempty"`
	Price          Slider              `json:"price"`
	Seats          []string            `json:"seats"`
	// Manifest is the file structure; nil means the seed is not known yet.
	Manifest       *Manifest           `json:"manifest"`
	Content        contentStore        `json:"content"`
	Completed      map[string]string   `json:"completed"`
	Sellers        map[string]*Seller  `json:"sellers"`
	Pools          map[string]*Pool    `json:"pools"`
	Requests       map[string]*Request `json:"requests"`
	Spent          Sats                `json:"spent"`
	SeenEvents     map[string]bool     `json:"seenEvents"`
}

// Event is one host fact applied to the kernel.
type Event struct {
	Type string `json:"type"`

	MaxBlockPrice     *Sats     `json:"maxBlockPrice,omitempty"`
	BaseSeats         *int64    `json:"baseSeats,omitempty"`
	FloatingSeats     *int64    `json:"floatingSeats,omitempty"`
	Slider            string    `json:"slider,omitempty"`
	Value             string    `json:"value,omitempty"`
	FileBytes         *int64    `json:"fileBytes,omitempty"`
	BlockBytes        *int64    `json:"blockBytes,omitempty"`
	BlockHashes       []string  `json:"blockHashes"`
	ReusedBlockHashes []string  `json:"reusedBlockHashes,omitempty"`
	Quote             *Quote    `json:"quote,omitempty"`
	SellerID          string    `json:"sellerId,omitempty"`
	Online            *bool     `json:"online,omitempty"`
	Enabled           *bool     `json:"enabled,omitempty"`
	InsufficientFunds bool      `json:"insufficientFunds,omitempty"`
	PoolID            string    `json:"poolId,omitempty"`
	SessionID         string    `json:"sessionId,omitempty"`
	Amount            Sats      `json:"amount,omitempty"`
	Committed         Sats      `json:"committed,omitempty"`
	Fees              *Fees     `json:"fees,omitempty"`
	CommandID         string    `json:"commandId,omitempty"`
	Released          *bool     `json:"released,omitempty"`
	RequestID         string    `json:"requestId,omitempty"`
	Bytes             *int64    `json:"bytes,omitempty"`
	Accepted          []string  `json:"accepted,omitempty"`
	Paid              string    `json:"paid,omitempty"`
	StartedAt         int64     `json:"startedAt,omitempty"`
	EndedAt           int64     `json:"endedAt,omitempty"`
	SafeToRetry       *bool     `json:"safeToRetry,omitempty"`
	Returned          string    `json:"returned,omitempty"`
	Spent             string    `json:"spent,omitempty"`

	EventID    string `json:"eventId"`
	TaskID     string `json:"taskId"`
	OccurredAt int64  `json:"occurredAt"`
	ReceivedAt int64  `json:"receivedAt"`
}

// Command is one host execution intent.
type Command struct {
	CommandID string `json:"commandId"`
	TaskID    string `json:"taskId"`
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
	TaskID                    string                     `json:"taskId"`
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

// MarshalJSON preserves the omitted-vs-empty distinction: nil slices are
// dropped so seed-only inputs never encode `"blockHashes": null` (which
// strict readers reject as an explicit null), while an explicitly empty
// ordered list survives the round-trip.
func (c CreateTaskInput) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		"taskId":   c.TaskID,
		"seedHash": c.SeedHash,
	}
	if c.FileBytes != nil {
		out["fileBytes"] = *c.FileBytes
	}
	if c.BlockBytes != nil {
		out["blockBytes"] = *c.BlockBytes
	}
	if c.BlockHashes != nil {
		out["blockHashes"] = append([]string{}, c.BlockHashes...)
	}
	if c.ReusedBlockHashes != nil {
		out["reusedBlockHashes"] = append([]string{}, c.ReusedBlockHashes...)
	}
	return json.Marshal(out)
}

// CreateTaskInput holds the explicit facts for a fresh task: only the seed
// hash (manifest unknown) or a complete, verified file structure. Providing
// the full file information asserts the local Seed is available and verified.
type CreateTaskInput struct {
	TaskID            string   `json:"taskId"`
	SeedHash          string   `json:"seedHash"`
	FileBytes         *int64   `json:"fileBytes,omitempty"`
	BlockBytes        *int64   `json:"blockBytes,omitempty"`
	BlockHashes       []string `json:"blockHashes"`
	ReusedBlockHashes []string `json:"reusedBlockHashes,omitempty"`
}
