import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navLinks } from './nav.js';

const urls = {
    proveBalance: 'http://localhost:5180',
    dashboard: 'http://localhost:7400',
    solanaDashboard: '',
};

void test('the nav links each app with an address, the page its heading names marked current', () => {
    assert.deepEqual(navLinks(urls, 'Prove balance'), [
        { label: 'Prove balance', url: 'http://localhost:5180', current: 'page' },
        { label: 'Bridge dashboard', url: 'http://localhost:7400', current: null },
    ]);
});

void test('the Solana dashboard is linked once it has an address', () => {
    const links = navLinks(
        { ...urls, solanaDashboard: 'https://solana.example' },
        'Bridge dashboard',
    );
    assert.deepEqual(links.at(-1), {
        label: 'Solana dashboard',
        url: 'https://solana.example',
        current: null,
    });
    assert.deepEqual(
        links.filter(({ current }) => current === 'page').map(({ label }) => label),
        ['Bridge dashboard'],
    );
});
