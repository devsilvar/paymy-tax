/**
 * Facade for backward compatibility.
 * Domain implementation moved to `@/services/settlement/settlement.service`.
 */
import * as settlementImpl from './settlement/settlement.service';

export const getPayoutPreview = settlementImpl.getPayoutPreview;
export const toggleAutoSplit = settlementImpl.toggleAutoSplit;
export const resolveSettlementAccount = settlementImpl.resolveSettlementAccount;
export const connectSettlementBank = settlementImpl.connectSettlementBank;
export const withdrawBalance = settlementImpl.withdrawBalance;
export const listPayoutHistory = settlementImpl.listPayoutHistory;
export const adminListWithdrawalRequests = settlementImpl.adminListWithdrawalRequests;
export const adminApproveWithdrawal = settlementImpl.adminApproveWithdrawal;
export const adminRejectWithdrawal = settlementImpl.adminRejectWithdrawal;
export const adminRequeryWithdrawal = settlementImpl.adminRequeryWithdrawal;
export const adminToggleAutoPayout = settlementImpl.adminToggleAutoPayout;

export * from './settlement/settlement.service';
