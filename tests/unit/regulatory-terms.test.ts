import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const mockLogAudit = jest.fn().mockResolvedValue(undefined as any);
jest.mock('../../src/lib/audit', () => ({
  logAudit: mockLogAudit,
}));

import { acceptRegulatoryTerms } from '@/controllers/auth.controller';
import prisma from '@/lib/prisma';
import { config } from '@/config';

describe('ARCH-11-C: Non-Custodial Regulatory Terms Acceptance Unit Suite', () => {
  const mockUserId = 'usr-reg-001';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockReqRes = (body: any = {}) => {
    const req: any = {
      user: { userId: mockUserId },
      body,
      ip: '192.168.1.100',
      headers: { 'user-agent': 'PayMyTax-Mobile/1.0' },
      get: (header: string) => req.headers[header.toLowerCase()],
    };

    const res: any = {
      statusCode: 200,
      jsonData: null,
      status: jest.fn().mockImplementation((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: jest.fn().mockImplementation((data: any) => {
        res.jsonData = data;
        return res;
      }),
    };

    const next = jest.fn();

    return { req, res, next };
  };

  test('1. Successfully records terms acceptance with custom version when provided', async () => {
    const customVersion = '2026.2-cbn-custom';
    const fakeAcceptedAt = new Date('2026-09-18T12:00:00.000Z');

    const updateSpy = jest.spyOn(prisma.user, 'update').mockResolvedValue({
      id: mockUserId,
      email: 'founder@fintech.ng',
      regulatoryTermsAcceptedAt: fakeAcceptedAt,
      regulatoryTermsVersion: customVersion,
    } as any);

    const { req, res, next } = createMockReqRes({ version: customVersion });

    await acceptRegulatoryTerms(req, res, next);

    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: mockUserId },
      data: {
        regulatoryTermsAcceptedAt: expect.any(Date),
        regulatoryTermsVersion: customVersion,
      },
      select: {
        id: true,
        email: true,
        regulatoryTermsAcceptedAt: true,
        regulatoryTermsVersion: true,
      },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        action: 'auth.regulatory_terms_accepted',
        resourceType: 'User',
        resourceId: mockUserId,
        newData: {
          version: customVersion,
          timestamp: fakeAcceptedAt,
        },
        ipAddress: '192.168.1.100',
        userAgent: 'PayMyTax-Mobile/1.0',
      })
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonData).toEqual({
      success: true,
      data: {
        id: mockUserId,
        email: 'founder@fintech.ng',
        regulatoryTermsAcceptedAt: fakeAcceptedAt,
        regulatoryTermsVersion: customVersion,
      },
      message: 'Non-custodial regulatory terms acknowledgment recorded successfully.',
    });
  });

  test('2. Defaults to config.regulatory.termsVersion when version is omitted in request body', async () => {
    const expectedDefaultVersion = config.regulatory.termsVersion;
    const fakeAcceptedAt = new Date('2026-09-18T14:30:00.000Z');

    const updateSpy = jest.spyOn(prisma.user, 'update').mockResolvedValue({
      id: mockUserId,
      email: 'merchant@lagos.ng',
      regulatoryTermsAcceptedAt: fakeAcceptedAt,
      regulatoryTermsVersion: expectedDefaultVersion,
    } as any);

    const { req, res, next } = createMockReqRes({});

    await acceptRegulatoryTerms(req, res, next);

    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: mockUserId },
      data: {
        regulatoryTermsAcceptedAt: expect.any(Date),
        regulatoryTermsVersion: expectedDefaultVersion,
      },
      select: {
        id: true,
        email: true,
        regulatoryTermsAcceptedAt: true,
        regulatoryTermsVersion: true,
      },
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockUserId,
        action: 'auth.regulatory_terms_accepted',
        newData: {
          version: expectedDefaultVersion,
          timestamp: fakeAcceptedAt,
        },
      })
    );

    expect(res.statusCode).toBe(200);
    expect(res.jsonData.data.regulatoryTermsVersion).toBe(expectedDefaultVersion);
  });

  test('3. Idempotency: Calling accept-regulatory-terms multiple times updates timestamp cleanly', async () => {
    const initialDate = new Date('2026-09-18T10:00:00.000Z');
    const updatedDate = new Date('2026-09-18T18:00:00.000Z');

    const updateSpy = jest.spyOn(prisma.user, 'update')
      .mockResolvedValueOnce({
        id: mockUserId,
        email: 'user@test.com',
        regulatoryTermsAcceptedAt: initialDate,
        regulatoryTermsVersion: config.regulatory.termsVersion,
      } as any)
      .mockResolvedValueOnce({
        id: mockUserId,
        email: 'user@test.com',
        regulatoryTermsAcceptedAt: updatedDate,
        regulatoryTermsVersion: config.regulatory.termsVersion,
      } as any);

    const call1 = createMockReqRes({});
    await acceptRegulatoryTerms(call1.req, call1.res, call1.next);

    const call2 = createMockReqRes({});
    await acceptRegulatoryTerms(call2.req, call2.res, call2.next);

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(call1.res.jsonData.data.regulatoryTermsAcceptedAt).toEqual(initialDate);
    expect(call2.res.jsonData.data.regulatoryTermsAcceptedAt).toEqual(updatedDate);
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
  });
});
