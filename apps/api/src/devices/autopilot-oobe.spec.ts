import { lockStatusWithOobe } from './wipe-detail';

// The first-boot OOBE check is the only Autopilot answer in this system that is
// not inference. Everything the station can see is read from OUTSIDE a running
// Windows; this is what the machine itself was told by Microsoft, out loud, on
// its own screen.
//
// So it outranks the offline roll-up in one direction only, and the asymmetry
// is the whole point of the function.
describe('lockStatusWithOobe', () => {
  it('an organisation on the OOBE screen makes the device LOCKED', () => {
    expect(lockStatusWithOobe('CLEAR', { result: 'organisation' })).toBe(
      'LOCKED',
    );
  });

  it('...even when every offline check came back clean', () => {
    // This is the case that matters: a wiped disk carries no local trace, so
    // the offline checks CAN'T find anything, and CLEAR would be the answer a
    // buyer acted on.
    expect(lockStatusWithOobe('CLEAR', { result: 'organisation' })).toBe(
      'LOCKED',
    );
    expect(lockStatusWithOobe(null, { result: 'organisation' })).toBe('LOCKED');
  });

  it('a generic OOBE does NOT promote a device to clear', () => {
    // A generic screen means no profile was served to that hardware hash on
    // that day. It says nothing about the domain join, firmware password or
    // Absolute agent the offline checks may have found - and nothing about a
    // registration somebody adds tomorrow.
    expect(lockStatusWithOobe('LOCKED', { result: 'generic' })).toBe('LOCKED');
    expect(lockStatusWithOobe('WARNING', { result: 'generic' })).toBe('WARNING');
    expect(lockStatusWithOobe('UNVERIFIED', { result: 'generic' })).toBe(
      'UNVERIFIED',
    );
  });

  it('a check that could not be made changes nothing', () => {
    expect(lockStatusWithOobe('UNVERIFIED', { result: 'blocked' })).toBe(
      'UNVERIFIED',
    );
    expect(lockStatusWithOobe('CLEAR', { result: 'blocked' })).toBe('CLEAR');
  });

  it('no check at all changes nothing, and is not a negative', () => {
    expect(lockStatusWithOobe('UNVERIFIED', null)).toBe('UNVERIFIED');
    expect(lockStatusWithOobe('UNVERIFIED', undefined)).toBe('UNVERIFIED');
    expect(lockStatusWithOobe('CLEAR', {})).toBe('CLEAR');
  });

  it('a value it does not recognise is not read as an answer', () => {
    // Anything other than the three known words is ignored rather than guessed
    // at. A stored value this code has never heard of must not silently become
    // "the device is fine".
    for (const junk of [
      { result: 'yes' },
      { result: 'ORGANISATION' },
      { result: 1 },
      { result: null },
      { result: true },
    ]) {
      expect(lockStatusWithOobe('UNVERIFIED', junk as never)).toBe('UNVERIFIED');
    }
  });

  it('is not fooled by a non-object', () => {
    for (const junk of ['organisation', 42, true, []]) {
      expect(lockStatusWithOobe('CLEAR', junk as never)).toBe('CLEAR');
    }
  });
});
