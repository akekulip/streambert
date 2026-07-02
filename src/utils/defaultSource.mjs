// Web-only: vidsrc-direct is server-extracted and has no desktop resolver, so
// it can only be the default in the web build.
export function defaultNonAnimeSource(isWeb) {
  return isWeb ? "vidsrc-direct" : "vidsrc";
}
