import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { calculateMentionPosition, getCaretCoordinates } from './textareaCaret';

let dom: JSDOM;
let originalGlobalDescriptors: Map<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  originalGlobalDescriptors = new Map(
    ['window', 'document', 'navigator'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  dom = new JSDOM('<!doctype html><div></div>');
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
  });
});

afterEach(() => {
  dom.window.close();
  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('textareaCaret', () => {
  it('computes caret coordinates for a textarea position', () => {
    const textarea = dom.window.document.createElement('textarea');
    textarea.value = 'hello @world';
    dom.window.document.body.appendChild(textarea);

    const coords = getCaretCoordinates(textarea, 6);
    assert.equal(typeof coords.top, 'number');
    assert.equal(typeof coords.left, 'number');
    assert.equal(typeof coords.height, 'number');
    assert.ok(coords.height > 0);
  });

  it('calculates mention position below cursor by default', () => {
    const container = dom.window.document.createElement('div');
    const textarea = dom.window.document.createElement('textarea');
    textarea.value = 'hello @world';
    container.appendChild(textarea);
    dom.window.document.body.appendChild(container);

    textarea.getBoundingClientRect = () => ({
      top: 50,
      bottom: 150,
      left: 20,
      right: 320,
      width: 300,
      height: 100,
      x: 20,
      y: 50,
      toJSON: () => {},
    });
    container.getBoundingClientRect = () => ({
      top: 40,
      bottom: 200,
      left: 10,
      right: 330,
      width: 320,
      height: 160,
      x: 10,
      y: 40,
      toJSON: () => {},
    });

    const pos = calculateMentionPosition(textarea, container, 6);
    assert.equal(typeof pos.top, 'number');
    assert.equal(typeof pos.left, 'number');
    assert.equal(pos.bottom, undefined);
    assert.ok(pos.top! > 0);
  });

  it('flips mention position above cursor when space below is insufficient', () => {
    const container = dom.window.document.createElement('div');
    const textarea = dom.window.document.createElement('textarea');
    textarea.value = 'chat message @agent';
    container.appendChild(textarea);
    dom.window.document.body.appendChild(container);

    // Position textarea near bottom of 800px window
    textarea.getBoundingClientRect = () => ({
      top: 700,
      bottom: 780,
      left: 20,
      right: 420,
      width: 400,
      height: 80,
      x: 20,
      y: 700,
      toJSON: () => {},
    });
    container.getBoundingClientRect = () => ({
      top: 690,
      bottom: 790,
      left: 10,
      right: 430,
      width: 420,
      height: 100,
      x: 10,
      y: 690,
      toJSON: () => {},
    });

    Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });

    const pos = calculateMentionPosition(textarea, container, 13);
    assert.equal(typeof pos.bottom, 'number');
    assert.equal(typeof pos.left, 'number');
    assert.equal(pos.top, undefined);
  });
});
