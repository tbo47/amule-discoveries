# Homebrew cask for aMule Discoveries.
#
# The REPLACE_WITH_* placeholders are filled in by the "Build macOS app"
# GitHub Actions workflow, which attaches the finished cask to each release.
#
# Install from a local checkout:
#   brew install --cask ./Casks/amule-discoveries.rb
# Or from a tap hosting this file:
#   brew tap tbo47/amule-discoveries https://github.com/tbo47/amule-discoveries
#   brew install --cask amule-discoveries
cask "amule-discoveries" do
  arch arm: "arm64", intel: "x64"

  version "REPLACE_WITH_VERSION"
  sha256 arm:   "REPLACE_WITH_ARM64_SHA256",
         intel: "REPLACE_WITH_X64_SHA256"

  url "https://github.com/tbo47/amule-discoveries/releases/download/v#{version}/amule-discoveries-#{version}-#{arch}.dmg"
  name "aMule Discoveries"
  desc "Desktop app to remote-control aMule and discover shared files"
  homepage "https://github.com/tbo47/amule-discoveries"

  app "aMule Discoveries.app"

  zap trash: [
    "~/Library/Application Support/aMule Discoveries",
    "~/Library/Preferences/com.tbo47.amule-discoveries.plist",
    "~/Library/Saved Application State/com.tbo47.amule-discoveries.savedState",
  ]

  caveats <<~EOS
    This app is not code-signed or notarized. If macOS refuses to open it,
    remove the quarantine attribute:
      xattr -cr "/Applications/aMule Discoveries.app"
  EOS
end
