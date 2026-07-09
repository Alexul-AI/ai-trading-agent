import { describe, expect, it } from "vitest";

import { parseForm4Xml } from "./secEdgar.js";

// Real Form 4 excerpt fetched from SEC EDGAR (Apple Inc., filed 2026-06-17)
// for reporting owner Jennifer Newstead. Covers a routine RSU
// vesting (code M) and tax withholding (code F) - neither should be
// flagged as an open-market transaction.
const ROUTINE_FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
    <reportingOwner>
        <reportingOwnerId>
            <rptOwnerCik>0001780525</rptOwnerCik>
            <rptOwnerName>Newstead Jennifer</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
            <isOfficer>true</isOfficer>
            <officerTitle>SVP, GC and Secretary</officerTitle>
        </reportingOwnerRelationship>
    </reportingOwner>
    <nonDerivativeTable>
        <nonDerivativeTransaction>
            <transactionDate><value>2026-06-15</value></transactionDate>
            <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>30104</value></transactionShares>
                <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts>
                <sharesOwnedFollowingTransaction><value>57784</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
        </nonDerivativeTransaction>
        <nonDerivativeTransaction>
            <transactionDate><value>2026-06-15</value></transactionDate>
            <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>16238</value></transactionShares>
                <transactionPricePerShare><value>296.42</value></transactionPricePerShare>
                <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts>
                <sharesOwnedFollowingTransaction><value>41546</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
        </nonDerivativeTransaction>
    </nonDerivativeTable>
</ownershipDocument>`;

// Synthetic open-market purchase/sale (codes P and S), which don't appear
// in the real sample above but are the codes the insider filter cares
// about most.
const OPEN_MARKET_FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
    <reportingOwner>
        <reportingOwnerId>
            <rptOwnerCik>0000000001</rptOwnerCik>
            <rptOwnerName>Test Insider</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
            <isDirector>true</isDirector>
        </reportingOwnerRelationship>
    </reportingOwner>
    <nonDerivativeTable>
        <nonDerivativeTransaction>
            <transactionDate><value>2026-06-01</value></transactionDate>
            <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>1000</value></transactionShares>
                <transactionPricePerShare><value>50.25</value></transactionPricePerShare>
                <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts>
                <sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
        </nonDerivativeTransaction>
        <nonDerivativeTransaction>
            <transactionDate><value>2026-06-02</value></transactionDate>
            <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
            <transactionAmounts>
                <transactionShares><value>500</value></transactionShares>
                <transactionPricePerShare><value>52.10</value></transactionPricePerShare>
                <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
            </transactionAmounts>
            <postTransactionAmounts>
                <sharesOwnedFollowingTransaction><value>4500</value></sharesOwnedFollowingTransaction>
            </postTransactionAmounts>
        </nonDerivativeTransaction>
    </nonDerivativeTable>
</ownershipDocument>`;

describe("parseForm4Xml", () => {
  it("extracts reporting owner name and officer title", () => {
    const transactions = parseForm4Xml(ROUTINE_FORM4_XML, "https://example.com");

    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.reportingOwnerName).toBe("Newstead Jennifer");
    expect(transactions[0]?.title).toBe("SVP, GC and Secretary");
  });

  it("does not flag routine option exercise (M) or tax withholding (F) as open-market", () => {
    const transactions = parseForm4Xml(ROUTINE_FORM4_XML, "https://example.com");

    expect(transactions.every((tx) => !tx.isOpenMarket)).toBe(true);
    expect(transactions[0]?.transactionCode).toBe("M");
    expect(transactions[1]?.transactionCode).toBe("F");
  });

  it("extracts exact shares, price, and post-transaction holdings", () => {
    const transactions = parseForm4Xml(ROUTINE_FORM4_XML, "https://example.com");
    const withholding = transactions[1];

    expect(withholding?.shares).toBe(16238);
    expect(withholding?.pricePerShare).toBe(296.42);
    expect(withholding?.acquiredOrDisposed).toBe("D");
    expect(withholding?.sharesOwnedAfter).toBe(41546);
  });

  it("treats a missing price (footnote-only) as null, not zero or NaN", () => {
    const transactions = parseForm4Xml(ROUTINE_FORM4_XML, "https://example.com");

    expect(transactions[0]?.pricePerShare).toBeNull();
  });

  it("flags open-market purchases (P) and sales (S) correctly", () => {
    const transactions = parseForm4Xml(OPEN_MARKET_FORM4_XML, "https://example.com");

    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.transactionCode).toBe("P");
    expect(transactions[0]?.isOpenMarket).toBe(true);
    expect(transactions[1]?.transactionCode).toBe("S");
    expect(transactions[1]?.isOpenMarket).toBe(true);
  });

  it("derives title from director/officer/10% owner flags when no officer title is given", () => {
    const transactions = parseForm4Xml(OPEN_MARKET_FORM4_XML, "https://example.com");

    expect(transactions[0]?.title).toBe("Director");
  });

  it("returns an empty array for a document with no ownershipDocument root", () => {
    const transactions = parseForm4Xml("<notForm4/>", "https://example.com");

    expect(transactions).toEqual([]);
  });
});
