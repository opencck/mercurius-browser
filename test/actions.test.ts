import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogLine, optionFor, scrollTarget } from '../src/guard.js';

const options = [
    { value: '', text: 'Выберите город' },
    { value: 'msk', text: 'Москва' },
    { value: 'spb', text: 'Санкт-Петербург' },
    { value: 'nsk', text: 'Новосибирск' },
];

test('an option is chosen by its value, then by its text, then by a unique part of the text', () => {
    assert.equal(optionFor(options, 'spb'), 'spb');
    assert.equal(optionFor(options, ' москва '), 'msk');
    assert.equal(optionFor(options, 'Петер'), 'spb');
    assert.equal(optionFor(options, 'о'), null, 'a part several options share is not a choice');
    assert.equal(optionFor(options, 'Казань'), null);
});

test('a scroll goes most of a screen or to an end', () => {
    assert.deepEqual(scrollTarget('down', 900), { by: 720 });
    assert.deepEqual(scrollTarget('up', 900), { by: -720 });
    assert.deepEqual(scrollTarget('top', 900), { to: 'top' });
    assert.deepEqual(scrollTarget('bottom', 900), { to: 'bottom' });
    assert.equal(scrollTarget('sideways', 900), null);
});

test('a dialog becomes one short line', () => {
    assert.equal(dialogLine('alert', 'Сессия\nистекла'), 'alert: Сессия истекла');
    assert.equal(dialogLine('confirm', 'x'.repeat(600)).length, 'confirm: '.length + 500);
});
