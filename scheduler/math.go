package scheduler

import (
	"fmt"
	"math/big"
	"regexp"
)

// MaxSafeInteger mirrors JavaScript Number.MAX_SAFE_INTEGER.
const MaxSafeInteger = int64(1)<<53 - 1

var satsPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

// kernelPanic carries a validation failure out of the pure helper functions.
type kernelPanic struct{ err error }

func (p kernelPanic) Error() string { return p.err.Error() }

func fail(format string, args ...any) {
	panic(kernelPanic{err: fmt.Errorf(format, args...)})
}

func parseSats(value Sats) (*big.Int, error) {
	if !satsPattern.MatchString(value) {
		return nil, fmt.Errorf("Invalid integer sats")
	}
	result, ok := new(big.Int).SetString(value, 10)
	if !ok {
		return nil, fmt.Errorf("Invalid integer sats")
	}
	return result, nil
}

// sats validates and parses a canonical decimal integer string.
func sats(value Sats) *big.Int {
	result, err := parseSats(value)
	if err != nil {
		panic(kernelPanic{err: err})
	}
	return result
}

func integer(value, min int64) int64 {
	if value < min || value > MaxSafeInteger {
		fail("Invalid integer quantity")
	}
	return value
}

var forbiddenIdentities = map[string]bool{
	"prototype":            true,
	"constructor":          true,
	"hasOwnProperty":       true,
	"isPrototypeOf":        true,
	"propertyIsEnumerable": true,
	"toLocaleString":       true,
	"toString":             true,
	"valueOf":              true,
	"__defineGetter__":     true,
	"__defineSetter__":     true,
	"__lookupGetter__":     true,
	"__lookupSetter__":     true,
	"__proto__":            true,
}

func identity(value string) string {
	if value == "" || forbiddenIdentities[value] {
		fail("Invalid identity")
	}
	return value
}

func reserve(fees Fees, count int64) *big.Int {
	result := new(big.Int).Set(sats(fees.Settlement))
	result.Add(result, sats(fees.ArbitrationBase))
	result.Add(result, new(big.Int).Mul(sats(fees.ArbitrationPerItem), big.NewInt(count)))
	return result
}

func price(quote Quote, content Content, isTail bool) *big.Int {
	if content.Kind == "seed" {
		return sats(quote.SeedPrice)
	}
	if isTail {
		if quote.TailPrice != nil {
			return sats(*quote.TailPrice)
		}
		return sats(quote.BlockPrice)
	}
	return sats(quote.BlockPrice)
}

func validateFees(fees Fees) {
	integer(fees.Version, 0)
	sats(fees.Opening)
	sats(fees.Settlement)
	sats(fees.ArbitrationBase)
	sats(fees.ArbitrationPerItem)
}

func validateQuote(quote Quote) {
	identity(quote.ID)
	identity(quote.SellerID)
	identity(quote.SessionID)
	for _, id := range quote.ContentIDs {
		identity(id)
	}
	integer(quote.Version, 0)
	integer(quote.ExpiresAt, 0)
	integer(quote.MaxBlocks, 1)
	sats(quote.BlockPrice)
	sats(quote.SeedPrice)
	if quote.TailPrice != nil {
		sats(*quote.TailPrice)
	}
	validateFees(quote.Fees)
}

func cloneQuote(quote Quote) Quote {
	clone := quote
	if quote.TailPrice != nil {
		tail := *quote.TailPrice
		clone.TailPrice = &tail
	}
	if quote.ContentIDs != nil {
		clone.ContentIDs = append([]string{}, quote.ContentIDs...)
	}
	return clone
}

func cloneFees(fees Fees) Fees { return fees }

func addSats(left, right Sats) Sats {
	return new(big.Int).Add(sats(left), sats(right)).String()
}
