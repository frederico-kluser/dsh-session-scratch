// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSelf, newMarker, ownerState, parseMarker, parseStartTime, realProc, selfIdentity } from '../src/owner.js';
import { fakeProc } from './helpers.js';

describe('parseStartTime', () => {
  it('lê o campo 22 mesmo com comm contendo espaços e parênteses', () => {
    const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i)), '987654', '1', '2'];
    assert.equal(parseStartTime(`42 (a) b (c)) ${fields.join(' ')}`), '987654');
  });
  it('linha inválida devolve null', () => {
    assert.equal(parseStartTime(null), null);
    assert.equal(parseStartTime('sem parênteses'), null);
    assert.equal(parseStartTime('1 (x) S 1 2'), null);
  });
  it('/proc/self/stat real tem starttime numérico (Linux)', { skip: process.platform !== 'linux' }, () => {
    const id = selfIdentity(realProc);
    assert.equal(id.pid, process.pid);
    assert.match(String(id.start), /^\d+$/);
    assert.match(String(id.boot), /^[0-9a-f-]{36}$/);
    assert.equal(ownerState(id, id, realProc), 'self');
  });
});

describe('ownerState', () => {
  const boot = 'boot-A';
  const proc = fakeProc({ self: 100, boot, procs: { 100: '5000', 200: '7000' } });
  const self = selfIdentity(proc, 100);

  it('self', () => assert.equal(ownerState(newMarker(self, 0), self, proc), 'self'));
  it('outro processo vivo (mesmo starttime)', () => {
    assert.equal(ownerState({ pid: 200, start: '7000', boot }, self, proc), 'alive');
  });
  it('pid morto', () => assert.equal(ownerState({ pid: 300, start: '1', boot }, self, proc), 'dead'));
  it('pid reaproveitado (starttime diferente)', () => {
    assert.equal(ownerState({ pid: 200, start: '6999', boot }, self, proc), 'dead');
  });
  it('boot_id diferente (reboot) = morto, mesmo com pid e starttime iguais', () => {
    assert.equal(ownerState({ pid: 200, start: '7000', boot: 'boot-B' }, self, proc), 'dead');
  });
  it('mesmo pid do processo atual mas starttime diferente = morto', () => {
    assert.equal(ownerState({ pid: 100, start: '4999', boot }, self, proc), 'dead');
  });
  it('sem /proc: cai para kill(0)', () => {
    const noProc = fakeProc({ self: 100, boot: null, procs: { 200: 'x' }, noProc: true });
    const me = selfIdentity(noProc, 100);
    assert.equal(ownerState({ pid: 200, start: null, boot: null }, me, noProc), 'alive');
    assert.equal(ownerState({ pid: 201, start: null, boot: null }, me, noProc), 'dead');
    const unknown = fakeProc({ self: 100, boot: null, procs: {}, noProc: true, killResult: () => null });
    assert.equal(ownerState({ pid: 201, start: null, boot: null }, me, unknown), 'unknown');
  });
  it('isSelf exige o trio', () => {
    assert.equal(isSelf({ pid: 100, start: '5000', boot }, self), true);
    assert.equal(isSelf({ pid: 100, start: '5000', boot: 'x' }, self), false);
    assert.equal(isSelf(null, self), false);
  });
});

describe('parseMarker', () => {
  it('aceita só o formato v1', () => {
    assert.deepEqual(parseMarker({ v: 1, pid: 5, start: '1', boot: 'b', createdAt: 9 }), { v: 1, pid: 5, start: '1', boot: 'b', createdAt: 9 });
    assert.equal(parseMarker({ v: 2, pid: 5 }), null);
    assert.equal(parseMarker({ v: 1, pid: -1 }), null);
    assert.equal(parseMarker({ v: 1, pid: 1.5 }), null);
    assert.equal(parseMarker('x'), null);
    assert.equal(parseMarker(null), null);
  });
});
