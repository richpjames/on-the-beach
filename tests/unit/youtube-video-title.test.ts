import { describe, expect, test } from "bun:test";
import {
  classifyYouTubeVideo,
  topicChannelName,
  type ClassifiedVideo,
} from "../../adapters/youtube/video-title";

describe("classifyYouTubeVideo", () => {
  test("files a rip channel's upload under the artist in its title, not the uploader", () => {
    // The upload behind the report that started this: a stranger's channel,
    // and a self-titled album the uploader named by its year.
    expect(classifyYouTubeVideo("Rosinha de Valença - 1973", "Cesar b costa")).toEqual({
      artist: "Rosinha de Valença",
      title: "1973",
    });
  });

  describe("dressing comes off", () => {
    const cases: Array<[string, ClassifiedVideo]> = [
      [
        "Marcos Valle – Previsão do Tempo (1973) [Full Album]",
        { artist: "Marcos Valle", title: "Previsão do Tempo", year: 1973 },
      ],
      ["Jorge Ben - Força Bruta (Álbum Completo)", { artist: "Jorge Ben", title: "Força Bruta" }],
      [
        "Los Jaivas - Alturas de Machu Picchu - Disco Completo",
        { artist: "Los Jaivas", title: "Alturas de Machu Picchu" },
      ],
      [
        "Gal Costa - Índia (LP Completo) [1973]",
        { artist: "Gal Costa", title: "Índia", year: 1973 },
      ],
      [
        "Tim Maia - Racional Vol. 1 (Official Audio)",
        { artist: "Tim Maia", title: "Racional Vol. 1" },
      ],
      [
        "Jards Macalé — Jards Macalé (Áudio Oficial)",
        { artist: "Jards Macalé", title: "Jards Macalé" },
      ],
      [
        "Os Mutantes - Os Mutantes (1968) | Full Album | HD",
        { artist: "Os Mutantes", title: "Os Mutantes", year: 1968 },
      ],
      [
        "Arthur Verocai - Arthur Verocai [1972 - Full Album]",
        { artist: "Arthur Verocai", title: "Arthur Verocai", year: 1972 },
      ],
      [
        "[FULL ALBUM] Novos Baianos - Acabou Chorare",
        { artist: "Novos Baianos", title: "Acabou Chorare" },
      ],
      [
        "Milton Nascimento - Clube da Esquina Full Album",
        { artist: "Milton Nascimento", title: "Clube da Esquina" },
      ],
      ["Caetano Veloso - Transa - 1972", { artist: "Caetano Veloso", title: "Transa", year: 1972 }],
      [
        "Simon &amp; Garfunkel - Bookends (Vinyl Rip)",
        { artist: "Simon & Garfunkel", title: "Bookends" },
      ],
      [
        // The bracketed year belongs to the record; the one hung off a pipe is
        // only a fallback.
        "Tom Zé - Estudando o Samba (1976) | 2016",
        { artist: "Tom Zé", title: "Estudando o Samba", year: 1976 },
      ],
    ];

    test.each(cases)("%s", (videoTitle, expected) => {
      expect(classifyYouTubeVideo(videoTitle, "Vinyl Rips")).toEqual(expected);
    });
  });

  describe("what the record is stays on", () => {
    const cases: Array<[string, ClassifiedVideo]> = [
      [
        "Neil Young - On the Beach (2016 Remaster)",
        { artist: "Neil Young", title: "On the Beach (2016 Remaster)" },
      ],
      [
        "Massive Attack - Blue Lines (Live)",
        { artist: "Massive Attack", title: "Blue Lines (Live)" },
      ],
      [
        "Hermeto Pascoal - Slaves Mass - Part 2",
        { artist: "Hermeto Pascoal", title: "Slaves Mass - Part 2" },
      ],
      // A span of years is a fact about the record, not a release date.
      [
        "Elis Regina - Falso Brilhante (1976-1977)",
        { artist: "Elis Regina", title: "Falso Brilhante (1976-1977)" },
      ],
      // Only a spaced dash splits, so a hyphenated name stays whole.
      ["Jean-Michel Jarre - Oxygène", { artist: "Jean-Michel Jarre", title: "Oxygène" }],
      // Dressing can be stripped from around a title but never stand in for
      // one: a song called "Audio" and an album called "Album" both exist.
      ["LSD - Audio (Official Video)", { artist: "LSD", title: "Audio" }],
      ["PiL - Album", { artist: "PiL", title: "Album" }],
      // Words in a script the dressing lists don't speak still name something:
      // noiseKey keeps no letters for them, but they are not noise.
      ["Кино - Группа крови", { artist: "Кино", title: "Группа крови" }],
      [
        "Elis Regina - Falso Brilhante (追憶)",
        { artist: "Elis Regina", title: "Falso Brilhante (追憶)" },
      ],
    ];

    test.each(cases)("%s", (videoTitle, expected) => {
      expect(classifyYouTubeVideo(videoTitle, "Vinyl Rips")).toEqual(expected);
    });
  });

  describe("when nothing names the record", () => {
    test("it is self-titled", () => {
      expect(classifyYouTubeVideo("Los Jaivas - Full Album", "Vinyl Rips")).toEqual({
        artist: "Los Jaivas",
        title: "Los Jaivas",
      });
      expect(classifyYouTubeVideo("Secos & Molhados - (Full Album)", "Vinyl Rips")).toEqual({
        artist: "Secos & Molhados",
        title: "Secos & Molhados",
      });
    });

    test("unless a year is all that's left, which stays the title as written", () => {
      // "Prince - 1999" is an album called 1999. Reading it as self-titled would
      // hand the resolver "Prince" by Prince — a different record — so the year
      // is kept, and the resolver tries the self-titled reading itself.
      expect(classifyYouTubeVideo("Prince - 1999 (Full Album)", "Vinyl Rips")).toEqual({
        artist: "Prince",
        title: "1999",
      });
      expect(classifyYouTubeVideo("Rosinha de Valença - Full Album (1973)", "Vinyl Rips")).toEqual({
        artist: "Rosinha de Valença",
        title: "1973",
      });
    });
  });

  describe("the year", () => {
    test("is read from beside the record's name, not beside the artist's", () => {
      // The bracket dates the artist's career, not the record — kept, it would
      // make the resolver insist on the wrong year.
      expect(classifyYouTubeVideo("Bad Brains (1979) - I Against I", "Cesar b costa")).toEqual({
        artist: "Bad Brains",
        title: "I Against I",
      });
      expect(
        classifyYouTubeVideo("Neil Young (1945) - Harvest Moon", "Neil Young - Topic"),
      ).toEqual({
        artist: "Neil Young",
        title: "Harvest Moon",
      });
    });
  });

  describe("the channel", () => {
    test("a Topic channel names the artist, and its video the track", () => {
      expect(classifyYouTubeVideo("Tema para Rosinha", "Rosinha de Valença - Topic")).toEqual({
        artist: "Rosinha de Valença",
        title: "Tema para Rosinha",
      });
    });

    test("a dash in a Topic video's title is part of the track's name", () => {
      expect(classifyYouTubeVideo("Harvest Moon - Remastered 2009", "Neil Young - Topic")).toEqual({
        artist: "Neil Young",
        title: "Harvest Moon - Remastered 2009",
      });
    });

    test("a Topic video that repeats the artist loses the repeat", () => {
      expect(classifyYouTubeVideo("Neil Young - Harvest Moon", "Neil Young - Topic")).toEqual({
        artist: "Neil Young",
        title: "Harvest Moon",
      });
    });

    test("an artist's own channel puts 'Title - Artist' the right way round", () => {
      expect(classifyYouTubeVideo("Harvest Moon - Neil Young", "Neil Young")).toEqual({
        artist: "Neil Young",
        title: "Harvest Moon",
      });
      expect(classifyYouTubeVideo("Harvest Moon - Neil Young", "NeilYoungVEVO")).toEqual({
        artist: "Neil Young",
        title: "Harvest Moon",
      });
    });

    test("a stranger's channel leaves the artist in front of the dash", () => {
      // Nothing says the halves are reversed, so the usual order stands.
      expect(classifyYouTubeVideo("Harvest Moon - Neil Young", "Cesar b costa")).toEqual({
        artist: "Harvest Moon",
        title: "Neil Young",
      });
    });

    test("with no dash, the channel is the artist, as it always was", () => {
      expect(classifyYouTubeVideo("On the Beach (2016 Remaster)", "neilyoungchannel")).toEqual({
        artist: "neilyoungchannel",
        title: "On the Beach (2016 Remaster)",
      });
      expect(classifyYouTubeVideo("Creep (Official Music Video)", "Radiohead")).toEqual({
        artist: "Radiohead",
        title: "Creep",
      });
    });

    test("with no dash and nothing named, the channel's record is self-titled", () => {
      expect(classifyYouTubeVideo("Full Album", "Los Jaivas")).toEqual({
        artist: "Los Jaivas",
        title: "Los Jaivas",
      });
    });
  });

  describe("missing input", () => {
    test("no video title invents no title", () => {
      expect(classifyYouTubeVideo(undefined, "Cesar b costa")).toEqual({ artist: "Cesar b costa" });
      expect(classifyYouTubeVideo(undefined, "Rosinha de Valença - Topic")).toEqual({
        artist: "Rosinha de Valença",
      });
    });

    test("no channel still reads the title", () => {
      expect(classifyYouTubeVideo("Rosinha de Valença - 1973", undefined)).toEqual({
        artist: "Rosinha de Valença",
        title: "1973",
      });
      expect(classifyYouTubeVideo("Creep", undefined)).toEqual({ title: "Creep" });
    });

    test("nothing at all reads as nothing", () => {
      expect(classifyYouTubeVideo(undefined, undefined)).toEqual({});
    });
  });
});

describe("topicChannelName", () => {
  test("reads the artist a Topic channel is named for, as written", () => {
    expect(topicChannelName("Rosinha de Valença - Topic")).toBe("Rosinha de Valença");
    expect(topicChannelName("Simon &amp; Garfunkel - Topic")).toBe("Simon & Garfunkel");
  });

  test("is null for any other channel", () => {
    expect(topicChannelName("Neil Young")).toBeNull();
    expect(topicChannelName("Topic")).toBeNull();
  });
});
