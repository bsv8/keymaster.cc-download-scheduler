package scheduler

// derivedFileInfo is the validated, normalized file structure.
type derivedFileInfo struct {
	manifest Manifest
	// blocks is the deduplicated block set.
	blocks map[string]bool
	// order lists the deduplicated block IDs in first-seen order, matching
	// the TypeScript Set insertion order.
	order []string
}

// deriveFileInfo validates the ordered block list. Any inconsistency aborts
// with a kernel error; callers guarantee the input state is discarded.
func deriveFileInfo(seedHash string, blockHashes []string) derivedFileInfo {
	identity(seedHash)
	if blockHashes == nil {
		fail("Invalid manifest")
	}
	blocks := map[string]bool{}
	order := []string{}
	for _, raw := range blockHashes {
		hash := identity(raw)
		if hash == seedHash {
			fail("Invalid manifest")
		}
		if !blocks[hash] {
			blocks[hash] = true
			order = append(order, hash)
		}
	}
	return derivedFileInfo{
		manifest: Manifest{BlockHashes: append([]string{}, blockHashes...)},
		blocks:   blocks,
		order:    order,
	}
}

func parseReused(blocks map[string]bool, reusedBlockHashes []string) []string {
	if reusedBlockHashes != nil {
		for _, id := range reusedBlockHashes {
			identity(id)
		}
	}
	seen := map[string]bool{}
	reused := []string{}
	for _, id := range reusedBlockHashes {
		if seen[id] {
			continue
		}
		seen[id] = true
		if !blocks[id] {
			fail("Unknown reused content")
		}
		reused = append(reused, id)
	}
	return reused
}

// parseResume validates the create input: a nil resume means the manifest is
// unknown; otherwise blockHashes is required ([] means known-empty). Explicit
// nulls reject; only omission means unprovided.
func parseResume(seedHash string, resume *CreateResume) (derivedFileInfo, []string, bool) {
	if resume == nil {
		return derivedFileInfo{}, nil, false
	}
	if resume.reusedWasNull {
		fail("Invalid manifest")
	}
	if resume.BlockHashes == nil {
		fail("Invalid manifest")
	}
	derived := deriveFileInfo(seedHash, resume.BlockHashes)
	return derived, parseReused(derived.blocks, resume.ReusedBlockHashes), true
}

// parseManifestPayload validates the flat manifest event: blockHashes is
// required ([] means known-empty).
func parseManifestPayload(seedHash string, blockHashes, reusedBlockHashes []string) (derivedFileInfo, []string) {
	if blockHashes == nil {
		fail("Invalid manifest")
	}
	derived := deriveFileInfo(seedHash, blockHashes)
	return derived, parseReused(derived.blocks, reusedBlockHashes)
}

// tailBlockID returns the unique purchase object for the last manifest
// position; empty or unknown manifests have no tail.
func tailBlockID(manifest *Manifest) (string, bool) {
	if manifest == nil || len(manifest.BlockHashes) == 0 {
		return "", false
	}
	return manifest.BlockHashes[len(manifest.BlockHashes)-1], true
}

// sameManifest reports whether two manifests are identical including order and
// duplicate positions.
func sameManifest(a, b *Manifest) bool {
	if a == nil || b == nil {
		return a == b
	}
	if len(a.BlockHashes) != len(b.BlockHashes) {
		return false
	}
	for index := range a.BlockHashes {
		if a.BlockHashes[index] != b.BlockHashes[index] {
			return false
		}
	}
	return true
}

func cloneManifest(manifest *Manifest) *Manifest {
	if manifest == nil {
		return nil
	}
	cloned := *manifest
	cloned.BlockHashes = append([]string{}, manifest.BlockHashes...)
	return &cloned
}

// validateRestoredContent enforces the single format: exactly one seed whose
// ID is the task seed hash, and the unique block set must match the derived
// manifest exactly. With no manifest, no block content may exist.
func validateRestoredContent(s *State, derived *derivedFileInfo) {
	seeds := 0
	blocks := map[string]bool{}
	for _, item := range s.Content.Values() {
		switch item.Kind {
		case "seed":
			seeds++
			if item.ID != s.SeedHash {
				fail("Unsupported task snapshot")
			}
		case "block":
			blocks[item.ID] = true
		default:
			fail("Unsupported task snapshot")
		}
	}
	if seeds != 1 {
		fail("Unsupported task snapshot")
	}
	if derived == nil {
		if len(blocks) != 0 {
			fail("Unsupported task snapshot")
		}
		return
	}
	if len(blocks) != len(derived.blocks) {
		fail("Content key mismatch")
	}
	for _, id := range derived.order {
		if !blocks[id] {
			fail("Content key mismatch")
		}
	}
}
