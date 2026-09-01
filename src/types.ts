export type Chain = "k-ruoka" | "s-kaupat" | "alko";

export interface Product {
	name: string;
	price: number | null;
	unitPrice: string | null;
	id: string;
	imageUrl: string | null;
	brand: string | null;
	category: string | null;
	isAvailable?: boolean | null;
	priceUnit?: string | null;
	priceIsApproximate?: boolean;
	abv?: number | null;
}

export interface Store {
	id: string;
	name: string;
	chain: Chain;
	location: string;
	isWebStore?: boolean;
	hasPickup?: boolean;
	hasHomeDelivery?: boolean;
}

export interface SearchResult {
	products: Product[];
	totalCount: number;
	query: string;
	storeId: string | null;
	chain: Chain;
}
