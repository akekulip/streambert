// Web default is Videasy (preferred: quality, own controls, fullscreen). The
// server-extracted vidsrc-direct player stays selectable but is not the default.
// Desktop has no vidsrc-direct resolver, so it defaults to the plain vidsrc embed.
export function defaultNonAnimeSource(isWeb) {
  return isWeb ? "videasy" : "vidsrc";
}
