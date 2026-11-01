package scheduler

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
)

// DebugEvent contains diagnostics only; never part of serialized business state.
// Host supplies ordering/timestamps and output. The component performs no I/O.
type DebugEvent struct {
	Component string `json:"component"`
	Event     string `json:"event"`
	Details   any    `json:"details"`
}
type DebugSink func(DebugEvent)

var debugConfig struct {
	sync.RWMutex
	sink DebugSink
}

func SetDebugSink(sink DebugSink) { debugConfig.Lock(); debugConfig.sink = sink; debugConfig.Unlock() }
func DebugEnabled() bool {
	debugConfig.RLock()
	defer debugConfig.RUnlock()
	return debugConfig.sink != nil
}

var debugPrivate = regexp.MustCompile(`(?i)password|passwd|private.?key|secret|mnemonic|token|credential|wif`)
var debugBinary = regexp.MustCompile(`(?i)signature|script|preimage|raw|signedTx|unsignedTx|draft|body|payloadBytes`)
var debugHex = regexp.MustCompile(`(?i)^[0-9a-f]+$`)
var debugCredential = regexp.MustCompile(`(?i)((?:password|secret|token|private.?key)\s*[=:]\s*)[^\s,;]+`)

func debugSummary(value reflect.Value, key string, depth int) any {
	if debugPrivate.MatchString(key) {
		return "[redacted]"
	}
	if depth > 20 {
		return "[depth]"
	}
	if !value.IsValid() {
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil
		}
		return debugSummary(value.Elem(), key, depth+1)
	}
	switch value.Kind() {
	case reflect.String:
		text := value.String()
		if debugBinary.MatchString(key) || len(text) > 128 || (len(text) >= 66 && debugHex.MatchString(text)) {
			size := len(text)
			if len(text)%2 == 0 && (text == "" || debugHex.MatchString(text)) {
				size /= 2
			}
			return map[string]any{"byteLength": size}
		}
		return debugCredential.ReplaceAllString(text, "${1}[redacted]")
	case reflect.Slice, reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return map[string]any{"byteLength": value.Len()}
		}
		rows := make([]any, value.Len())
		for i := range rows {
			rows[i] = debugSummary(value.Index(i), key, depth+1)
		}
		return rows
	case reflect.Map:
		rows := map[string]any{}
		it := value.MapRange()
		for it.Next() {
			name := fmt.Sprint(it.Key().Interface())
			rows[name] = debugSummary(it.Value(), name, depth+1)
		}
		return rows
	case reflect.Struct:
		rows := map[string]any{}
		typ := value.Type()
		for i := 0; i < value.NumField(); i++ {
			field := typ.Field(i)
			if field.PkgPath != "" {
				continue
			}
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			rows[name] = debugSummary(value.Field(i), name, depth+1)
		}
		return rows
	}
	if value.CanInterface() {
		return value.Interface()
	}
	return nil
}
func debugLog(event string, details func() any) {
	debugConfig.RLock()
	sink := debugConfig.sink
	debugConfig.RUnlock()
	if sink == nil {
		return
	}
	defer func() { _ = recover() }()
	sink(DebugEvent{Component: "trade-scheduler", Event: event, Details: debugSummary(reflect.ValueOf(details()), "", 0)})
}
func debugStep(previous State, event Event, result *Result, err *error) func() {
	if !DebugEnabled() {
		return func() {}
	}
	debugLog("operation.start", func() any { return map[string]any{"operation": "step", "input": event, "state": previous} })
	return func() {
		if *err != nil {
			debugLog("operation.rejected", func() any { return map[string]any{"operation": "step", "reason": (*err).Error()} })
		}
		debugLog("operation.finish", func() any { return map[string]any{"operation": "step", "result": result} })
	}
}
