import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import * as alko from "../browser/alko.ts";
import * as kRuoka from "../browser/k-ruoka.ts";
import * as sKaupat from "../browser/s-kaupat.ts";
import { logger } from "../logger.ts";

let cachedDefaultKRuokaStoreId: string | null = null;

function normalizeStoreName(value: string): string {
	return value.trim().toLocaleLowerCase("fi-FI").replace(/\s+/g, " ");
}

async function resolveDefaultKRuokaStoreId(): Promise<string | null> {
	if (cachedDefaultKRuokaStoreId) return cachedDefaultKRuokaStoreId;

	const configuredId = process.env.DEFAULT_K_RUOKA_STORE_ID?.trim();
	if (configuredId) {
		cachedDefaultKRuokaStoreId = configuredId;
		return configuredId;
	}

	const configuredQuery = process.env.DEFAULT_K_RUOKA_STORE_QUERY?.trim();
	if (!configuredQuery) return null;

	const stores = await kRuoka.getStores(configuredQuery);
	if (stores.length === 0) {
		throw new Error(`No K-Ruoka store matched DEFAULT_K_RUOKA_STORE_QUERY=${configuredQuery}`);
	}

	const wanted = normalizeStoreName(configuredQuery);
	const exact = stores.find((store) => normalizeStoreName(store.name) === wanted);
	const contains = stores.find((store) => normalizeStoreName(store.name).includes(wanted));
	const selected = exact ?? contains ?? stores[0];
	if (!selected) return null;

	cachedDefaultKRuokaStoreId = selected.id;
	logger.info(
		{ query: configuredQuery, storeId: selected.id, storeName: selected.name },
		"Resolved default K-Ruoka store",
	);
	return selected.id;
}

export function registerSearchTool(server: McpServer): void {
	server.registerTool(
		"search_products",
		{
			description:
				"Search for products. Supports K-Ruoka (k-ruoka.fi), S-Kaupat (s-kaupat.fi), and Alko (alko.fi). storeId is required for S-Kaupat. For K-Ruoka it may be omitted when DEFAULT_K_RUOKA_STORE_ID or DEFAULT_K_RUOKA_STORE_QUERY is configured. Alko can search the national catalog without a store.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search query (e.g., 'maito', 'leipä', 'punaviini')"),
				storeId: z
					.string()
					.optional()
					.describe(
						"Store ID from get_stores. Required for S-Kaupat. Optional for K-Ruoka when a server default is configured, and optional for Alko.",
					),
				chain: z.enum(["k-ruoka", "s-kaupat", "alko"]).describe("Which chain to search"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.default(10)
					.describe("Maximum number of results to return (default: 10, max: 50)"),
			}),
		},
		async ({ query, storeId, chain, limit }) => {
			try {
				let resolvedStoreId = storeId;
				if (chain === "k-ruoka" && !resolvedStoreId) {
					resolvedStoreId = (await resolveDefaultKRuokaStoreId()) ?? undefined;
				}

				if ((chain === "k-ruoka" || chain === "s-kaupat") && !resolvedStoreId) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									chain === "k-ruoka"
										? "storeId is required for k-ruoka unless DEFAULT_K_RUOKA_STORE_ID or DEFAULT_K_RUOKA_STORE_QUERY is configured. Call get_stores first to get a valid storeId."
										: "storeId is required for s-kaupat. Call get_stores first to get a valid storeId.",
							},
						],
						isError: true,
					};
				}

				const result =
					chain === "k-ruoka"
						? await kRuoka.searchProducts(query, resolvedStoreId ?? "", limit)
						: chain === "s-kaupat"
							? await sKaupat.searchProducts(query, resolvedStoreId ?? "", limit)
							: await alko.searchProducts(query, resolvedStoreId, limit);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error) {
				logger.error({ err: error, chain, query, storeId }, "Product search failed");
				return {
					content: [
						{
							type: "text" as const,
							text: `Error searching products: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
