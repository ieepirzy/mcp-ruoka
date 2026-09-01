import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { Product, SearchResult, Store } from "../types.ts";
import { getBuildNumber, getPage, resetSession } from "./session.ts";

const API_TIMEOUT = 30_000;
const STORE_SEARCH_LIMIT = 50;

const BlockedResponseSchema = z.object({
	_blocked: z.literal(true),
	_status: z.number(),
	_body: z.string(),
});

const ApiProductSchema = z.object({
	id: z.string(),
	product: z.object({
		ean: z.string(),
		localizedName: z.object({ finnish: z.string() }),
		images: z.array(z.string()).optional(),
		isAvailable: z.boolean().optional(),
		mobilescan: z
			.object({
				pricing: z
					.object({
						normal: z
							.object({
								price: z.number().optional(),
								unit: z.string().optional(),
								isApproximate: z.boolean().optional(),
								unitPrice: z
									.object({
										value: z.number().optional(),
										unit: z.string().optional(),
										contentSize: z.number().optional(),
									})
									.optional(),
							})
							.optional(),
					})
					.optional(),
			})
			.optional(),
		brand: z.object({ name: z.string().optional() }).optional(),
		category: z
			.object({
				localizedName: z.object({ finnish: z.string() }).optional(),
			})
			.optional(),
	}),
});

const ApiSearchResponseSchema = z.object({
	result: z.array(ApiProductSchema).optional(),
	totalHits: z.number().int().nonnegative().optional(),
	error: z.object({ message: z.string() }).optional(),
});

const SearchEvalResultSchema = z.union([BlockedResponseSchema, ApiSearchResponseSchema]);
type SearchEvalResult = z.infer<typeof SearchEvalResultSchema>;

const ApiStoreSchema = z.object({
	id: z.string(),
	name: z.string(),
	chain: z.string().optional(),
	chainName: z.string().optional(),
	location: z.string().optional(),
	isWebStore: z.boolean().optional(),
	hasPickup: z.boolean().optional(),
	hasHomeDelivery: z.boolean().optional(),
});

const ApiStoresResponseSchema = z.object({
	results: z.array(ApiStoreSchema).optional(),
	totalHits: z.number().int().nonnegative().optional(),
});

const StoresEvalResultSchema = z.union([BlockedResponseSchema, ApiStoresResponseSchema]);
type StoresEvalResult = z.infer<typeof StoresEvalResultSchema>;

function isBlocked(
	data: SearchEvalResult | StoresEvalResult,
): data is z.infer<typeof BlockedResponseSchema> {
	return "_blocked" in data;
}

function parseProduct(item: z.infer<typeof ApiProductSchema>): Product {
	const p = item.product;
	const pricing = p.mobilescan?.pricing?.normal;
	const comparisonPrice = pricing?.unitPrice;
	const comparisonValue = comparisonPrice?.value;
	const comparisonUnit = comparisonPrice?.unit;

	return {
		name: p.localizedName.finnish,
		price: pricing?.price ?? null,
		unitPrice:
			comparisonValue !== undefined && comparisonUnit
				? `${comparisonValue.toFixed(2).replace(".", ",")} €/${comparisonUnit}`
				: null,
		id: p.ean,
		imageUrl: p.images?.[0] ?? null,
		brand: p.brand?.name ?? null,
		category: p.category?.localizedName?.finnish ?? null,
		isAvailable: p.isAvailable ?? null,
		priceUnit: pricing?.unit ?? null,
		priceIsApproximate: pricing?.isApproximate ?? false,
	};
}

function parseStore(item: z.infer<typeof ApiStoreSchema>): Store {
	return {
		id: item.id,
		name: item.name,
		chain: "k-ruoka",
		location: item.location ?? "",
		isWebStore: item.isWebStore ?? false,
		hasPickup: item.hasPickup ?? false,
		hasHomeDelivery: item.hasHomeDelivery ?? false,
	};
}

async function fetchSearchApi(
	query: string,
	storeId: string,
	limit: number,
): Promise<SearchEvalResult> {
	const page = await getPage();
	const buildNumber = getBuildNumber();

	const raw = await page.evaluate(
		async ({
			query,
			storeId,
			limit,
			buildNumber,
			timeout,
		}: {
			query: string;
			storeId: string;
			limit: number;
			buildNumber: string;
			timeout: number;
		}) => {
			const params = new URLSearchParams({
				offset: "0",
				language: "fi",
				storeId,
				limit: String(limit),
				discountFilter: "false",
				isTosTrOffer: "false",
			});
			const res = await fetch(`/kr-api/v2/product-search/${encodeURIComponent(query)}?${params}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"x-k-build-number": buildNumber,
				},
				signal: AbortSignal.timeout(timeout),
			});
			const body = await res.text();
			if (res.status === 403 || body.includes("cf-challenge")) {
				return { _blocked: true, _status: res.status, _body: body };
			}
			try {
				return JSON.parse(body);
			} catch {
				return { _blocked: true, _status: res.status, _body: body };
			}
		},
		{ query, storeId, limit, buildNumber, timeout: API_TIMEOUT },
	);

	try {
		return SearchEvalResultSchema.parse(raw);
	} catch (err) {
		logger.error({ err }, "Unexpected search API response shape");
		throw err;
	}
}

async function fetchStoresApi(query?: string): Promise<StoresEvalResult> {
	const page = await getPage();
	const buildNumber = getBuildNumber();

	const raw = await page.evaluate(
		async ({ query, buildNumber, timeout, limit }) => {
			const headers = {
				accept: "application/json",
				"content-type": "application/json",
				"x-k-build-number": buildNumber,
			};
			const res = query
				? await fetch("/kr-api/stores/search", {
						method: "POST",
						headers,
						body: JSON.stringify({ query, limit, offset: 0 }),
						signal: AbortSignal.timeout(timeout),
					})
				: await fetch("/kr-api/stores", {
						headers,
						signal: AbortSignal.timeout(timeout),
					});
			const body = await res.text();
			if (res.status === 403 || body.includes("cf-challenge")) {
				return { _blocked: true, _status: res.status, _body: body };
			}
			try {
				return JSON.parse(body);
			} catch {
				return { _blocked: true, _status: res.status, _body: body };
			}
		},
		{
			query: query?.trim() || undefined,
			buildNumber,
			timeout: API_TIMEOUT,
			limit: STORE_SEARCH_LIMIT,
		},
	);

	try {
		return StoresEvalResultSchema.parse(raw);
	} catch (err) {
		logger.error({ err }, "Unexpected stores API response shape");
		throw err;
	}
}

export async function searchProducts(
	query: string,
	storeId: string,
	limit: number,
): Promise<SearchResult> {
	logger.info({ query, storeId, limit }, "K-Ruoka product search");

	let data = await fetchSearchApi(query, storeId, limit);

	if (isBlocked(data)) {
		logger.warn({ status: data._status }, "Cloudflare block on product search, resetting session");
		await resetSession();
		data = await fetchSearchApi(query, storeId, limit);
		if (isBlocked(data)) {
			throw new Error("Blocked by Cloudflare after session reset");
		}
	}

	if (data.error) {
		throw new Error(`K-Ruoka API error: ${data.error.message}`);
	}

	const products = (data.result ?? []).map(parseProduct);

	logger.info(
		{ query, resultCount: products.length, totalHits: data.totalHits },
		"K-Ruoka search completed",
	);

	return {
		products,
		totalCount: data.totalHits ?? products.length,
		query,
		storeId,
		chain: "k-ruoka",
	};
}

export async function getStores(query?: string): Promise<Store[]> {
	logger.info({ query: query ?? "all" }, "Fetching K-Ruoka stores");

	let data = await fetchStoresApi(query);

	if (isBlocked(data)) {
		logger.warn({ status: data._status }, "Cloudflare block on stores fetch, resetting session");
		await resetSession();
		data = await fetchStoresApi(query);
		if (isBlocked(data)) {
			throw new Error("Blocked by Cloudflare after session reset");
		}
	}

	const stores = (data.results ?? []).map(parseStore);

	logger.info(
		{ query: query ?? "all", storeCount: stores.length, totalHits: data.totalHits },
		"K-Ruoka stores fetched",
	);

	return stores;
}
