# Homebrew cask for Deskmate, for a tap repository named homebrew-deskmate (docs/HOMEBREW.md).
# `node scripts/update-cask.cjs <version> <path to the .dmg>` fills in version and sha256 for a release.
cask "deskmate" do
  version "1.0.0-rc.1"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/MuhammadMurtuzaHussain/deskmate/releases/download/v#{version}/Deskmate-#{version}-mac-universal.dmg",
      verified: "github.com/MuhammadMurtuzaHussain/deskmate/"
  name "Deskmate"
  desc "Desktop AI agent with a Live2D or 3D character that talks, listens and works your apps"
  homepage "https://github.com/MuhammadMurtuzaHussain/deskmate"

  livecheck do
    url :url
    strategy :github_releases
  end

  # Signed builds update themselves (electron-updater); set this to true once releases are notarized.
  auto_updates false
  depends_on macos: ">= :ventura"

  app "Deskmate.app"

  uninstall quit: "com.murtuza.deskmate"

  zap trash: [
    "~/Library/Application Support/Deskmate",
    "~/Library/Caches/deskmate-updater",
    "~/Library/Logs/Deskmate",
    "~/Library/Preferences/com.murtuza.deskmate.plist",
    "~/Library/Saved Application State/com.murtuza.deskmate.savedState",
  ]

  caveats <<~EOS
    Deskmate asks for Accessibility, Screen Recording and Microphone in its first-run tour.
    If macOS says it cannot check the app for malicious software (a build that is not notarized yet),
    open System Settings → Privacy & Security and press "Open Anyway" once.
  EOS
end
