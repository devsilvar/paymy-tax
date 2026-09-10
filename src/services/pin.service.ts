/**
 * Facade for backward compatibility.
 * Domain implementation moved to `@/services/settlement/pin.service`.
 */
import * as pinImpl from './settlement/pin.service';

export const getPinStatus = pinImpl.getPinStatus;
export const setupPin = pinImpl.setupPin;
export const verifyPin = pinImpl.verifyPin;
export const verifyStepUpToken = pinImpl.verifyStepUpToken;
export const changePin = pinImpl.changePin;

export * from './settlement/pin.service';
