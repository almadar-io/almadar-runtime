/**
 * `browser/page-facts`: the closed fact set, the argument check, and the page reader the client handler uses.
 */

import type { BrowserPageFacts, PageFactField, RuntimeValue } from '@almadar/core';

const PAGE_FACT_FIELDS: readonly PageFactField[] = ['hostname', 'referrer', 'screenWidth'];

/** The fields a `browser/page-facts` call asks for, or why the call is refused before anything is read. */
export function parsePageFactFields(value: RuntimeValue | undefined): { fields: PageFactField[] } | { error: string } {
    if (!Array.isArray(value) || value.length === 0) {
        return { error: 'browser/page-facts: the fields must be a non-empty list of hostname, referrer, screenWidth' };
    }
    const fields: PageFactField[] = [];
    for (const entry of value) {
        const field = PAGE_FACT_FIELDS.find((known) => known === entry);
        if (field === undefined) {
            return { error: `browser/page-facts: ${String(entry)} is not one of ${PAGE_FACT_FIELDS.join(', ')}` };
        }
        if (fields.includes(field)) return { error: `browser/page-facts: ${field} is listed twice` };
        fields.push(field);
    }
    return { fields };
}

/** Read `fields` from the page in list order. No window or document is `available: false`; a throwing getter rejects. */
export function readPageFacts(fields: readonly PageFactField[]): BrowserPageFacts {
    const facts: BrowserPageFacts = { available: false, hostname: '', referrer: '', screenWidth: null };
    if (typeof window === 'undefined' || typeof document === 'undefined') return facts;
    facts.available = true;
    for (const field of fields) {
        if (field === 'hostname') facts.hostname = window.location.hostname;
        else if (field === 'referrer') facts.referrer = document.referrer;
        else facts.screenWidth = window.screen?.width ?? null;
    }
    return facts;
}
