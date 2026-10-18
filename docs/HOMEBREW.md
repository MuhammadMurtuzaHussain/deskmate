# Homebrew

Deskmate installs with Homebrew from a tap of its own:

```bash
brew install --cask muhammadmurtuzahussain/deskmate/deskmate
```

That needs a tap repository, which does not exist yet. Setting it up, once:

1. Create a public GitHub repository named **`homebrew-deskmate`** under the same account
   (`MuhammadMurtuzaHussain/homebrew-deskmate`). The `homebrew-` prefix is what makes `brew tap` find it.
2. Copy `packaging/homebrew/Casks/deskmate.rb` from this repository to `Casks/deskmate.rb` in the tap.
3. For each release, after the draft is published:

   ```bash
   # the DMG from the release (or the one you built)
   curl -LO https://github.com/MuhammadMurtuzaHussain/deskmate/releases/download/v1.0.0/Deskmate-1.0.0-mac-universal.dmg
   node scripts/update-cask.cjs 1.0.0 Deskmate-1.0.0-mac-universal.dmg > ../homebrew-deskmate/Casks/deskmate.rb
   cd ../homebrew-deskmate && brew audit --cask --online Casks/deskmate.rb && git commit -am "deskmate 1.0.0" && git push
   ```

   `update-cask.cjs` fills in `version` and `sha256` (add `--write` to update the template here too).
4. Check it from a clean state:

   ```bash
   brew untap muhammadmurtuzahussain/deskmate 2>/dev/null; brew install --cask muhammadmurtuzahussain/deskmate/deskmate
   ```

Notes on the cask:

- `auto_updates false` for now. Once releases are signed and notarized the app updates itself; set it to `true` then,
  so `brew upgrade` leaves it alone.
- Until releases are notarized, macOS asks once before opening the app; the cask's caveats say how (System Settings →
  Privacy & Security → Open Anyway). Homebrew's own cask repository does not take apps that fail Gatekeeper, which is
  one more reason to sign before submitting there. A tap has no such rule.
- `zap` removes her settings, memory and the updater's cache (`brew uninstall --zap --cask deskmate`).
