import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO supported_tokens (symbol, mint_address, network, is_usd_pegged, decimals)
    VALUES (
      'USDC',
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      'solana-devnet',
      true,
      6
    )
    ON CONFLICT (symbol, network) DO UPDATE SET
      mint_address = EXCLUDED.mint_address,
      is_usd_pegged = EXCLUDED.is_usd_pegged,
      decimals = EXCLUDED.decimals
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM supported_tokens
    WHERE symbol = 'USDC'
      AND network = 'solana-devnet'
      AND mint_address = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  `.execute(db);
}
