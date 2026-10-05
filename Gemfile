source "https://rubygems.org"

# Aligned with frenzypenguin-media / neohiro / openstageisland so all four
# network sites build with the same local toolchain.
#
# This file previously asked for the `github-pages` metagem, which is not
# installed on a normal workstation, so `jekyll build` failed with
# Bundler::GemNotFound before a single page was rendered. GitHub Pages never
# needed this file — Pages builds with its own pinned gem set and only reads the
# Gemfile to decide whether to run Bundler at all — so the metagem bought nothing
# and cost the ability to build or verify the site locally.
#
# Every plugin listed in _config.yml (jekyll-feed, jekyll-seo-tag,
# jekyll-sitemap) is named here individually, so a missing plugin is a missing
# gem rather than a silent divergence from the other three sites.
gem "jekyll", "~> 4.3"
gem "minima", "~> 2.5"
gem "jekyll-feed", "~> 0.17"
gem "jekyll-seo-tag", "~> 2.8"
gem "jekyll-sitemap", "~> 1.4"
gem "kramdown-parser-gfm"
gem "webrick", "~> 1.8"
