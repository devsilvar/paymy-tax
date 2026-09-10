/**
 * Store & E-Commerce Domain Interfaces & Contracts
 * 
 * Phase 4 Storefront-Ready Integration Contract.
 * Defines models, payment payloads, and lifecycle statuses matching
 * the architecture blueprint (codebaserescture.md).
 *
 * @author WallX Engineering Team
 */

export type OrderStatus = 'pending' | 'paid' | 'processing' | 'fulfilled' | 'cancelled';

export type OrderFulfillmentStatus =
  | 'unfulfilled'
  | 'fulfilled'
  | 'backordered'
  | 'partially_fulfilled';

export type StorePaymentChannel = 'paycode' | 'dva' | 'card' | 'cash';

export interface Store {
  id: string;
  businessId: string;
  slug: string;
  storeName: string;
  description?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  storeId: string;
  name: string;
  description?: string | null;
  price: number;
  costPrice?: number | null;
  stockQuantity: number;
  trackInventory: boolean;
  imageUrl?: string | null;
  isTaxable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLine {
  id: string;
  orderId: string;
  productId: string;
  name?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  storeId: string;
  businessId: string;
  orderNumber: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  deliveryAddress?: string | null;
  status: OrderStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  paymentChannel?: StorePaymentChannel | string | null;
  paidAt?: Date | null;
  linkedSaleId?: string | null;
  lines: OrderLine[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderPaymentPayload {
  reference: string;
  orderNumber: string;
  amount: number;
  channel?: string;
  paidAt?: Date | string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  businessId?: string;
  storeId?: string;
  orderId?: string;
  rawPayload?: unknown;
}

export interface CreateStoreInput {
  businessId: string;
  slug: string;
  storeName: string;
  description?: string;
  logoUrl?: string;
  bannerUrl?: string;
}

export interface CreateProductInput {
  storeId: string;
  name: string;
  description?: string;
  price: number;
  costPrice?: number;
  stockQuantity?: number;
  trackInventory?: boolean;
  imageUrl?: string;
  isTaxable?: boolean;
}

export interface CreateOrderInput {
  storeId: string;
  businessId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  deliveryAddress?: string;
  deliveryFee?: number;
  lines: Array<{
    productId: string;
    name?: string;
    quantity: number;
    unitPrice: number;
  }>;
}
