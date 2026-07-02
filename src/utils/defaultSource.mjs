// Web default is VidSrc Direct: server-extracted + proxied, so the ad-serving
// page never reaches any browser — ad-free automatically for every user (LAN or
// remote), no per-device setup, played in our own controls/fullscreen/subtitles.
// (Videasy can't be extracted server-side — encrypted sources + anti-headless —
// so its iframe reintroduces client-side ads; it stays a manual option only.)
// Desktop has no vidsrc-direct resolver, so it defaults to the plain vidsrc embed.
export function defaultNonAnimeSource(isWeb) {
  return isWeb ? "vidsrc-direct" : "vidsrc";
}
