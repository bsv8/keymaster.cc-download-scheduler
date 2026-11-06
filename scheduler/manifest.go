package scheduler

// derivedFileInfo is the validated, normalized file structure.
type derivedFileInfo struct {
	manifest Manifest
	// blocks maps the deduplicated block IDs to their derived byte length.
	blocks map[string]int64
	// order lists the deduplicated block IDs in first-seen order, matching
	// the TypeScript Map insertion order.
	order []string
}

// contentBytesOf returns the required block bytes; seeds carry none.
func contentBytesOf(item Content) int64 {
	if item.Bytes == nil {
		fail("Content bytes missing")
	}
	return *item.Bytes
}

// blockCount mirrors the TS blockCount helper: ceil(fileBytes / blockBytes),
// with 0 bytes mapping to 0 blocks.
func blockCountFor(fileBytes, blockBytes int64) int64 {
	integer(fileBytes, 0)
	integer(blockBytes, 1)
	if fileBytes == 0 {
		return 0
	}
	return (fileBytes-1)/blockBytes + 1
}

func blockBytesAt(fileBytes, blockBytes int64, index int64) int64 {
	remaining := fileBytes - index * blockBytes
	if remaining < blockBytes {
		return remaining
	}
	return blockBytes
}

// deriveFileInfo validates and derives the file structure. Any inconsistency
// aborts with a kernel error; callers guarantee the input state is discarded.
func deriveFileInfo(seedHash string, fileBytes, blockBytes int64, blockHashes []string) derivedFileInfo {
	identity(seedHash)
	integer(fileBytes, 0)
	integer(blockBytes, 1)
	expected := blockCountFor(fileBytes, blockBytes)
	if int64(len(blockHashes)) != expected {
		fail("Manifest block count mismatch")
	}
	blocks := map[string]int64{}
	order := []string{}
	for index, raw := range blockHashes {
		hash := identity(raw)
		if hash == seedHash {
			fail("Invalid manifest")
		}
		size := blockBytesAt(fileBytes, blockBytes, int64(index))
		if previous, ok := blocks[hash]; ok && previous != size {
			fail("Conflicting content identity")
		}
		if _, ok := blocks[hash]; !ok {
			order = append(order, hash)
		}
		blocks[hash] = size
	}
	return derivedFileInfo{
		manifest: Manifest{FileBytes: fileBytes, BlockBytes: blockBytes, BlockHashes: append([]string{}, blockHashes...)},
		blocks:   blocks,
		order:    order,
	}
}

// parseFileInfo combines the create/manifest input validation: the three
// fields are provided together or not at all; reused hashes must be unique
// blocks of the manifest.
func parseFileInfo(seedHash string, fileBytes, blockBytes *int64, blockHashes, reusedBlockHashes []string) (derivedFileInfo, []string, bool) {
	provided := 0
	for _, value := range []*int64{fileBytes, blockBytes} {
		if value != nil {
			provided++
		}
	}
	if blockHashes != nil {
		provided++
	}
	if reusedBlockHashes != nil {
		for _, id := range reusedBlockHashes {
			identity(id)
		}
	}
	if provided == 0 {
		if reusedBlockHashes != nil {
			fail("Invalid manifest")
		}
		return derivedFileInfo{}, nil, false
	}
	if provided != 3 {
		fail("Invalid manifest")
	}
	derived := deriveFileInfo(seedHash, *fileBytes, *blockBytes, blockHashes)
	seen := map[string]bool{}
	reused := []string{}
	for _, id := range reusedBlockHashes {
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, ok := derived.blocks[id]; !ok {
			fail("Unknown reused content")
		}
		reused = append(reused, id)
	}
	return derived, reused, true
}

// sameManifest reports whether two manifests are identical including order and
// duplicate positions.
func sameManifest(a, b *Manifest) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.FileBytes != b.FileBytes || a.BlockBytes != b.BlockBytes || len(a.BlockHashes) != len(b.BlockHashes) {
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

// validateRestoredContent enforces the single new format: exactly one seed
// whose ID is the task seed hash (seeds carry no bytes), and the unique block
// set must match the derived manifest exactly (bytes included). With no
// manifest, no block content may exist.
func validateRestoredContent(s *State, derived *derivedFileInfo) {
	seeds := 0
	blocks := map[string]int64{}
	for _, item := range s.Content.Values() {
		switch item.Kind {
		case "seed":
			seeds++
			if item.ID != s.SeedHash {
				fail("Unsupported task snapshot")
			}
			if item.Bytes != nil {
				fail("Unsupported task snapshot")
			}
		case "block":
			if item.Bytes == nil {
				fail("Unsupported task snapshot")
			}
			integer(*item.Bytes, 1)
			blocks[item.ID] = *item.Bytes
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
		want := derived.blocks[id]
		got, ok := blocks[id]
		if !ok {
			fail("Content key mismatch")
		}
		if got != want {
			fail("Conflicting content identity")
		}
	}
}
