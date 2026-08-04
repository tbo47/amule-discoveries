# Homebrew cask for Muleteer.
#
# The REPLACE_WITH_* placeholders are filled in by the "Build macOS app"
# GitHub Actions workflow, which attaches the finished cask to each release.
#
# Install from a local checkout:
#   brew install --cask ./Casks/muleteer.rb
# Or from a tap hosting this file:
#   brew tap tbo47/muleteer https://github.com/tbo47/amule-discoveries
#   brew install --cask muleteer
cask "muleteer" do
  arch arm: "arm64", intel: "x64"

  version "REPLACE_WITH_VERSION"
  sha256 arm:   "REPLACE_WITH_ARM64_SHA256",
         intel: "REPLACE_WITH_X64_SHA256"

  url "https://github.com/tbo47/amule-discoveries/releases/download/v#{version}/muleteer-#{version}-#{arch}.dmg"
  name "Muleteer"
  desc "Media center for aMule: play your files and discover music and video from the network"
  homepage "https://github.com/tbo47/amule-discoveries"

  app "Muleteer.app"

  zap trash: [
    "~/Library/Application Support/Muleteer",
    "~/Library/Preferences/com.tbo47.muleteer.plist",
    "~/Library/Saved Application State/com.tbo47.muleteer.savedState",
  ]

  caveats <<~EOS
    This app is not code-signed or notarized. If macOS refuses to open it,
    remove the quarantine attribute:
      xattr -cr "/Applications/Muleteer.app"
  EOS
end
