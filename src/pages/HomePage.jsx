import { useState, useEffect, useMemo, useCallback } from "react";
import MediaCard from "../components/MediaCard";
import TrendingCarousel from "../components/TrendingCarousel";
import { PlayIcon, StarIcon } from "../components/Icons";
import { imgUrl, tmdbFetch } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { storage } from "../utils/storage";
import { loadHomeLayout, loadHomeViewMode } from "../utils/homeLayout";

const BROWSE_FILTERS_KEY = "browseFilters";
const DEFAULT_BROWSE_FILTERS = {
  mediaType: "movie",
  genreId: "",
  minRating: "",
  year: "",
  sortBy: "popularity.desc",
};

function getRecentHistoryItem(history) {
  if (!history || history.length === 0) return null;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = history.filter(
    (h) => h.watchedAt && h.watchedAt > sevenDaysAgo,
  );
  if (recent.length === 0) return null;
  return recent[Math.floor(Math.random() * recent.length)];
}

function loadBrowseFilters() {
  const saved = storage.get(BROWSE_FILTERS_KEY) || {};
  return { ...DEFAULT_BROWSE_FILTERS, ...saved };
}

function buildYearOptions() {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let year = currentYear + 1; year >= 1950; year--) years.push(year);
  return years;
}

const YEAR_OPTIONS = buildYearOptions();
const RATING_OPTIONS = ["", "5", "6", "7", "8", "9"];
const SORT_OPTIONS = [
  { value: "popularity.desc", label: "Most Popular" },
  { value: "vote_average.desc", label: "Highest Rated" },
  { value: "primary_release_date.desc", label: "Newest Releases" },
  { value: "primary_release_date.asc", label: "Oldest Releases" },
];

export default function HomePage({
  trending,
  trendingTV,
  loading,
  onSelect,
  progress,
  inProgress,
  offline,
  onRetry,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  history,
  apiKey,
}) {
  const hero = trending[0];

  const [similarItems, setSimilarItems] = useState([]);
  const [similarSource, setSimilarSource] = useState(null);
  const [topRatedItems, setTopRatedItems] = useState([]);
  const [browseFilters, setBrowseFilters] = useState(loadBrowseFilters);
  const [browseGenres, setBrowseGenres] = useState([]);
  const [browseItems, setBrowseItems] = useState([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Load layout config (order + visibility) once on mount
  const [layout] = useState(() => loadHomeLayout());
  const { order: rowOrder, visible: rowVisible } = layout;

  const [viewMode] = useState(() => loadHomeViewMode());

  useEffect(() => {
    storage.set(BROWSE_FILTERS_KEY, browseFilters);
  }, [browseFilters]);

  // All items for batch ratings fetch
  const allItems = useMemo(
    () => [
      ...inProgress,
      ...trending.map((i) => ({ ...i, media_type: "movie" })),
      ...trendingTV.map((i) => ({ ...i, media_type: "tv" })),
      ...similarItems,
      ...topRatedItems,
      ...browseItems,
    ],
    [inProgress, trending, trendingTV, similarItems, topRatedItems, browseItems],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) =>
      isRestricted(getRatingForItem(item, ratingsMap).minAge, ageLimitSetting),
    [ratingsMap, ageLimitSetting],
  );

  // Enrich ratingsMap with restricted flag for carousels
  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingsMap, ageLimitSetting]);

  // Fetch similar items based on recent watch history
  useEffect(() => {
    if (!apiKey || offline || !history || history.length === 0) return;
    const source = getRecentHistoryItem(history);
    if (!source) return;
    setSimilarSource(source);
    const type = source.media_type === "tv" ? "tv" : "movie";
    const tryFetch = (endpoint) =>
      tmdbFetch(`/${type}/${source.id}/${endpoint}`, apiKey).then((data) =>
        (data.results || [])
          .slice(0, 10)
          .map((item) => ({ ...item, media_type: type })),
      );
    tryFetch("similar")
      .then((results) => {
        if (results.length > 0) {
          setSimilarItems(results);
          return;
        }
        return tryFetch("recommendations").then(setSimilarItems);
      })
      .catch(() =>
        tryFetch("recommendations")
          .then(setSimilarItems)
          .catch(() => {}),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline, history?.length]);

  // Fetch top rated movies + TV, merge and shuffle
  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    Promise.all([
      tmdbFetch("/movie/top_rated?page=1", apiKey, {
        signal: controller.signal,
      }),
      tmdbFetch("/tv/top_rated?page=1", apiKey, { signal: controller.signal }),
    ])
      .then(([moviesData, tvData]) => {
        const movies = (moviesData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "movie" }));
        const tv = (tvData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "tv" }));
        const merged = [];
        const max = Math.max(movies.length, tv.length);
        for (let i = 0; i < max; i++) {
          if (movies[i]) merged.push(movies[i]);
          if (tv[i]) merged.push(tv[i]);
        }
        setTopRatedItems(merged);
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("Top rated fetch failed", e);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline]);

  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    const mediaType = browseFilters.mediaType === "tv" ? "tv" : "movie";

    tmdbFetch(`/genre/${mediaType}/list`, apiKey, {
      signal: controller.signal,
    })
      .then((data) => setBrowseGenres(data.genres || []))
      .catch((e) => {
        if (e.name !== "AbortError") setBrowseGenres([]);
      });

    return () => controller.abort();
  }, [apiKey, browseFilters.mediaType, offline]);

  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    const mediaType = browseFilters.mediaType === "tv" ? "tv" : "movie";
    const params = new URLSearchParams({
      include_adult: "false",
      include_video: "false",
      language: "en-US",
      page: "1",
      sort_by: browseFilters.sortBy,
      "vote_count.gte": browseFilters.minRating ? "80" : "30",
    });

    if (browseFilters.genreId) params.set("with_genres", browseFilters.genreId);
    if (browseFilters.minRating)
      params.set("vote_average.gte", browseFilters.minRating);
    if (browseFilters.year) {
      if (mediaType === "movie") {
        params.set("primary_release_year", browseFilters.year);
      } else {
        params.set("first_air_date_year", browseFilters.year);
      }
    }

    const sortValue = browseFilters.sortBy;
    const isDateSort =
      sortValue === "primary_release_date.desc" ||
      sortValue === "primary_release_date.asc";
    if (mediaType === "tv" && isDateSort) {
      params.set(
        "sort_by",
        sortValue === "primary_release_date.asc"
          ? "first_air_date.asc"
          : "first_air_date.desc",
      );
    }

    setBrowseLoading(true);
    tmdbFetch(`/discover/${mediaType}?${params.toString()}`, apiKey, {
      signal: controller.signal,
    })
      .then((data) => {
        setBrowseItems(
          (data.results || [])
            .slice(0, 18)
            .map((item) => ({ ...item, media_type: mediaType })),
        );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setBrowseItems([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBrowseLoading(false);
      });

    return () => controller.abort();
  }, [apiKey, browseFilters, offline]);

  const updateBrowseFilter = useCallback((key, value) => {
    setBrowseFilters((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "mediaType") next.genreId = "";
      return next;
    });
  }, []);

  const browseSummary = useMemo(() => {
    const bits = [
      browseFilters.mediaType === "tv" ? "Series" : "Movies",
      browseFilters.genreId
        ? browseGenres.find((g) => String(g.id) === String(browseFilters.genreId))
            ?.name
        : "All genres",
      browseFilters.minRating
        ? `${browseFilters.minRating}+ rating`
        : "Any rating",
      browseFilters.year || "Any year",
    ];
    return bits.filter(Boolean).join(" · ");
  }, [browseFilters, browseGenres]);

  // Stable pre-built item arrays for carousels, capped at 10
  const trendingMovieItems = useMemo(
    () => trending.slice(0, 10).map((i) => ({ ...i, media_type: "movie" })),
    [trending],
  );
  const trendingTVItems = useMemo(
    () => trendingTV.slice(0, 10).map((i) => ({ ...i, media_type: "tv" })),
    [trendingTV],
  );

  return (
    <div className="fade-in">
      {offline && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            gap: 16,
            color: "var(--text2)",
          }}
        >
          <div style={{ fontSize: 48 }}>📡</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
            No internet connection
          </div>
          <div style={{ fontSize: 14, color: "var(--text3)" }}>
            Trending and search require an internet connection. Your downloads
            and library still work offline.
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}

      {!offline && loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}

      {!loading && hero && (
        <div className="hero">
          <div
            className="hero-bg"
            style={{
              backgroundImage: `url(${imgUrl(hero.backdrop_path, "original")})`,
            }}
          />
          <div className="hero-gradient" />
          <div className="hero-content">
            <div className="hero-type">Trending · Movie</div>
            <div className="hero-title">{hero.title || hero.name}</div>
            <div className="hero-meta">
              <span className="hero-rating">
                <StarIcon /> {hero.vote_average?.toFixed(1)}
              </span>
              <span>{hero.release_date?.slice(0, 4)}</span>
            </div>
            <div className="hero-overview">{hero.overview}</div>
            <div className="hero-actions">
              <button
                className="btn btn-primary"
                onClick={() => onSelect(hero)}
              >
                <PlayIcon /> Watch Now
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => onSelect(hero)}
              >
                More Info
              </button>
            </div>
          </div>
        </div>
      )}

      {!offline && (
        <div className="section">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div className="section-title">Browse</div>
            <div style={{ color: "var(--text3)", fontSize: 13 }}>
              {browseSummary}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
              marginBottom: 18,
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>Type</span>
              <select
                className="search-input"
                value={browseFilters.mediaType}
                onChange={(e) => updateBrowseFilter("mediaType", e.target.value)}
              >
                <option value="movie">Movies</option>
                <option value="tv">TV Series</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>
                Category
              </span>
              <select
                className="search-input"
                value={browseFilters.genreId}
                onChange={(e) => updateBrowseFilter("genreId", e.target.value)}
              >
                <option value="">All categories</option>
                {browseGenres.map((genre) => (
                  <option key={genre.id} value={genre.id}>
                    {genre.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>
                Minimum Rating
              </span>
              <select
                className="search-input"
                value={browseFilters.minRating}
                onChange={(e) => updateBrowseFilter("minRating", e.target.value)}
              >
                <option value="">Any rating</option>
                {RATING_OPTIONS.filter(Boolean).map((rating) => (
                  <option key={rating} value={rating}>
                    {rating}+ stars
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>Year</span>
              <select
                className="search-input"
                value={browseFilters.year}
                onChange={(e) => updateBrowseFilter("year", e.target.value)}
              >
                <option value="">Any year</option>
                {YEAR_OPTIONS.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, color: "var(--text3)" }}>Sort By</span>
              <select
                className="search-input"
                value={browseFilters.sortBy}
                onChange={(e) => updateBrowseFilter("sortBy", e.target.value)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {browseLoading ? (
            <div className="loader">
              <div className="spinner" />
            </div>
          ) : browseItems.length > 0 ? (
            <div className="cards-grid">
              {browseItems.map((item) => {
                const rk = `${item.media_type}_${item.id}`;
                const rd = enrichedRatingsMap[rk] || {};
                return (
                  <MediaCard
                    key={`${item.media_type}_${item.id}`}
                    item={item}
                    onClick={() => onSelect(item)}
                    progress={0}
                    watched={watched}
                    onMarkWatched={onMarkWatched}
                    onMarkUnwatched={onMarkUnwatched}
                    ageRating={rd.cert}
                    restricted={rd.restricted}
                  />
                );
              })}
            </div>
          ) : (
            <div
              style={{
                color: "var(--text3)",
                fontSize: 14,
                padding: "14px 0 6px",
              }}
            >
              No {browseFilters.mediaType === "tv" ? "series" : "movies"} found
              for those filters.
            </div>
          )}
        </div>
      )}

      {rowOrder.map((id) => {
        if (!rowVisible[id]) return null;

        if (id === "continue") {
          if (inProgress.length === 0) return null;
          return (
            <div key="continue" className="section">
              <div className="section-title">Continue Watching</div>
              <div className="cards-grid">
                {inProgress.map((item) => {
                  const pk =
                    item.media_type === "movie"
                      ? `movie_${item.id}`
                      : `tv_${item.id}_s${item.season}e${item.episode}`;
                  const r = getRating(item);
                  const restr = itemRestricted(item);
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={progress[pk] || 0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={r.cert}
                      restricted={restr}
                    />
                  );
                })}
              </div>
            </div>
          );
        }

        const renderList = (key, title, titleHighlight, items) => {
          if (!items || items.length === 0) return null;
          return (
            <div key={key} className="section">
              <div className="section-title">
                {titleHighlight ? (
                  <>
                    {title}&nbsp;
                    <span style={{ color: "var(--red)" }}>
                      {titleHighlight}
                    </span>
                  </>
                ) : (
                  title
                )}
              </div>
              <div className="cards-grid">
                {items.map((item) => {
                  const type = item.media_type === "tv" ? "tv" : "movie";
                  const rk = `${type}_${item.id}`;
                  const rd = enrichedRatingsMap[rk] || {};
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={rd.cert}
                      restricted={rd.restricted}
                    />
                  );
                })}
              </div>
            </div>
          );
        };

        if (id === "similar") {
          if (!similarSource || similarItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "similar",
              "Similar to",
              similarSource.title || similarSource.name,
              similarItems,
            );
          return (
            <TrendingCarousel
              key="similar"
              items={similarItems}
              title="Similar to"
              titleHighlight={similarSource.title || similarSource.name}
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingMovies") {
          if (trendingMovieItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingMovies",
              "Trending Movies",
              null,
              trendingMovieItems,
            );
          return (
            <TrendingCarousel
              key="trendingMovies"
              items={trendingMovieItems}
              title="Trending Movies"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingTV") {
          if (trendingTVItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingTV",
              "Trending Series",
              null,
              trendingTVItems,
            );
          return (
            <TrendingCarousel
              key="trendingTV"
              items={trendingTVItems}
              title="Trending Series"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "topRated") {
          if (topRatedItems.length === 0) return null;
          if (viewMode === "list")
            return renderList("topRated", "Top Rated", null, topRatedItems);
          return (
            <TrendingCarousel
              key="topRated"
              items={topRatedItems}
              title="Top Rated"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
