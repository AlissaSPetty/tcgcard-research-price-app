/**
 * Map Pokémon TCG API v2 card objects to `pokemon_card_images` rows.
 * @see https://docs.pokemontcg.io/api-reference/cards/card-object/
 */

export interface PokemonCardImageRow {
  external_id: string;
  name: string;
  image_url: string | null;
  holo_image_url: string | null;
  reverse_holo_image_url: string | null;
  card_set: string | null;
  details: string | null;
  rarity: string | null;
  evolves_from: string | null;
  artist: string | null;
  card_number: string | null;
}

export function mapPokemonTcgApiCardToRow(
  card: Record<string, unknown>,
): PokemonCardImageRow | null {
  const id = card.id;
  if (id == null || String(id).trim() === "") return null;

  const images = card.images as { small?: string; large?: string } | undefined;
  const large = images?.large?.trim() || null;
  const small = images?.small?.trim() || null;

  const setObj = card.set as { name?: string } | undefined;
  const attacks = card.attacks as
    | Array<{ name?: string; damage?: string; text?: string }>
    | undefined;
  const abilities = card.abilities as
    | Array<{ name?: string; text?: string }>
    | undefined;
  const types = card.types as string[] | undefined;

  const parts: string[] = [];
  if (card.hp != null) parts.push(`HP: ${card.hp}`);
  if (types?.length) parts.push(`Types: ${types.join(", ")}`);
  if (card.flavorText != null) parts.push(String(card.flavorText));
  if (abilities?.length) {
    for (const a of abilities.slice(0, 5)) {
      if (a.name) {
        parts.push(
          a.text ? `${a.name}: ${a.text}` : a.name,
        );
      }
    }
  }
  if (attacks?.length) {
    for (const a of attacks.slice(0, 6)) {
      const line = [a.name, a.damage].filter(Boolean).join(" ");
      if (line) parts.push(line);
      if (a.text) parts.push(a.text);
    }
  }
  let details = parts.join("\n").trim();
  if (details.length > 4000) details = `${details.slice(0, 3997)}...`;

  const name = String(card.name ?? "").trim() || String(id);

  return {
    external_id: String(id),
    name,
    image_url: large ?? small,
    holo_image_url: large ?? small,
    reverse_holo_image_url: small ?? large,
    card_set: setObj?.name?.trim() || null,
    details: details.length > 0 ? details : null,
    rarity: card.rarity != null ? String(card.rarity) : null,
    evolves_from: card.evolvesFrom != null ? String(card.evolvesFrom) : null,
    artist: card.artist != null ? String(card.artist) : null,
    card_number: card.number != null ? String(card.number) : null,
  };
}
