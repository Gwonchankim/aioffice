// @vitest-environment happy-dom
import { canonicalM0DegradedHealth } from '@orion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { App } from '../src/App.js';

function healthResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the Korean heading and loading state while health is pending', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => undefined)),
    );

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Orion Console 대시보드' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('상태 정보를 불러오는 중입니다.');
  });

  it('renders the degraded M0 health status, subsystem mapping, and measured resources', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse(canonicalM0DegradedHealth)));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '서버 상태' })).toBeTruthy();
    expect(screen.getByText('저하됨 (degraded)')).toBeTruthy();
    expect(screen.getAllByText('초기화되지 않음')).toHaveLength(3);
    expect(screen.getByText('42.5%')).toBeTruthy();
    expect(screen.getByText('2147483648 bytes')).toBeTruthy();
  });
  it('renders initialized M1 database health while scheduler and retention remain uninitialized', async () => {
    const m1Health = structuredClone(canonicalM0DegradedHealth);
    m1Health.data.status = 'healthy';
    m1Health.data.database = 'ok';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse(m1Health)));

    render(<App />);

    expect(await screen.findByText('정상 (healthy)')).toBeTruthy();
    expect(screen.getByText('정상 (ok)')).toBeTruthy();
    expect(screen.getAllByText('초기화되지 않음')).toHaveLength(2);
  });

  it.each([
    ['an invalid payload', {}],
    ['a payload missing required health fields', { data: { status: 'degraded' } }],
  ])(
    'renders an explicit error for %s instead of a healthy fallback',
    async (_description, payload) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse(payload)));

      render(<App />);

      expect((await screen.findByRole('alert')).textContent).toContain(
        '오류: 상태 정보를 안전하게 표시할 수 없습니다.',
      );
      expect(screen.queryByRole('heading', { name: '서버 상태' })).toBeNull();
      expect(screen.queryByText('저하됨 (degraded)')).toBeNull();
    },
  );

  it('retries from an error without retaining a prior health display', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(healthResponse(canonicalM0DegradedHealth));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByText('저하됨 (degraded)')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
