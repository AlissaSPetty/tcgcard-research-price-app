import { mapPokemonTcgApiCardToRow } from "../../supabase/functions/_shared/listing/pokemon_tcg_api";

describe("mapPokemonTcgApiCardToRow", () => {
  it("maps Pokémon TCG API v2 card shape", () => {
    const row = mapPokemonTcgApiCardToRow({
      id: "base1-4",
      name: "Charizard",
      hp: "120",
      types: ["Fire"],
      evolvesFrom: "Charmeleon",
      number: "4",
      artist: "Mitsuhiro Arita",
      rarity: "Rare Holo",
      flavorText: "Spits fire hot enough to melt boulders.",
      set: { name: "Base" },
      images: {
        small: "https://images.pokemontcg.io/base1/4.png",
        large: "https://images.pokemontcg.io/base1/4_hires.png",
      },
    });
    expect(row).not.toBeNull();
    expect(row!.external_id).toBe("base1-4");
    expect(row!.name).toBe("Charizard");
    expect(row!.image_url).toContain("hires");
    expect(row!.card_set).toBe("Base");
    expect(row!.card_number).toBe("4");
    expect(row!.rarity).toBe("Rare Holo");
    expect(row!.evolves_from).toBe("Charmeleon");
    expect(row!.artist).toBe("Mitsuhiro Arita");
    expect(row!.details).toContain("HP: 120");
  });

  it("returns null without id", () => {
    expect(mapPokemonTcgApiCardToRow({ name: "X" })).toBeNull();
  });
});
