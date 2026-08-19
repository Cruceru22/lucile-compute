/**
 * The consent rule that lets a Compatibility report read a FRIEND's chart.
 *
 * `/report` accepts a `partnerConnectionId` so the app can offer accepted
 * friends alongside the user's own saved profiles. That chart belongs to
 * somebody else, and this service holds the SERVICE-ROLE key — RLS does not
 * protect it here, so the gate is code, and this is that code under test.
 *
 * The rule mirrors the `get_connection_chart` RPC the app uses: accepted
 * connection, caller is one of its two parties, real counterparty. (Blocks are
 * a separate table and are checked around this predicate, in
 * `loadConnectionChart`.)
 */
import { describe, expect, it } from 'vitest';

import { connectionCounterpartyId } from '../src/ai/storage.js';

const ME = 'user-me';
const THEM = 'user-them';

describe('connectionCounterpartyId', () => {
  it('resolves the other party when I sent the accepted invite', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: ME, addressee_id: THEM, status: 'accepted' }),
    ).toBe(THEM);
  });

  it('resolves the other party when I accepted their invite', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: THEM, addressee_id: ME, status: 'accepted' }),
    ).toBe(THEM);
  });

  it('refuses a pending connection — consent is not given until it is accepted', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: ME, addressee_id: THEM, status: 'pending' }),
    ).toBeNull();
  });

  it('refuses a declined connection', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: THEM, addressee_id: ME, status: 'declined' }),
    ).toBeNull();
  });

  it('refuses a connection the caller is not a party to — the core leak', () => {
    expect(
      connectionCounterpartyId(ME, {
        requester_id: 'stranger-a',
        addressee_id: 'stranger-b',
        status: 'accepted',
      }),
    ).toBeNull();
  });

  it('refuses an invite nobody has redeemed (no second person yet)', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: ME, addressee_id: null, status: 'accepted' }),
    ).toBeNull();
  });

  it('refuses a self-connection rather than passing back my own chart', () => {
    expect(
      connectionCounterpartyId(ME, { requester_id: ME, addressee_id: ME, status: 'accepted' }),
    ).toBeNull();
  });

  it('refuses a missing row (an id that matches no connection)', () => {
    expect(connectionCounterpartyId(ME, null)).toBeNull();
  });
});
