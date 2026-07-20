import { useEffect, useState } from 'react';

import { fetchHealth } from './health-client.js';
import { createHealthViewModel } from './health-view-model.js';
import type { HealthViewModel } from './health-view-model.js';

type HealthLoadState =
  { kind: 'loading' } | { kind: 'error' } | { kind: 'success'; viewModel: HealthViewModel };

export function App() {
  const [retryCount, setRetryCount] = useState(0);
  const [state, setState] = useState<HealthLoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void fetchHealth()
      .then(createHealthViewModel)
      .then((viewModel) => {
        if (!cancelled) {
          setState(viewModel === null ? { kind: 'error' } : { kind: 'success', viewModel });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: 'error' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [retryCount]);

  function retry() {
    setState({ kind: 'loading' });
    setRetryCount((current) => current + 1);
  }

  return (
    <main>
      <h1>Orion Console 대시보드</h1>
      {state.kind === 'loading' ? <p role="status">상태 정보를 불러오는 중입니다.</p> : null}
      {state.kind === 'error' ? (
        <section aria-label="상태 오류" role="alert">
          <p>오류: 상태 정보를 안전하게 표시할 수 없습니다.</p>
          <button type="button" onClick={retry}>
            다시 시도
          </button>
        </section>
      ) : null}
      {state.kind === 'success' ? <HealthSummary viewModel={state.viewModel} /> : null}
    </main>
  );
}

function HealthSummary({ viewModel }: { viewModel: HealthViewModel }) {
  return (
    <>
      <section aria-label="서버 상태">
        <h2>서버 상태</h2>
        <p>{viewModel.overallStatus}</p>
      </section>
      <section aria-label="M1 하위 시스템">
        <h2>M1 하위 시스템</h2>
        <dl>
          <dt>데이터베이스</dt>
          <dd>{viewModel.databaseStatus}</dd>
          <dt>스케줄러</dt>
          <dd>{viewModel.schedulerStatus}</dd>
          <dt>보존</dt>
          <dd>{viewModel.retentionStatus}</dd>
        </dl>
      </section>
      <section aria-label="리소스">
        <h2>리소스</h2>
        <dl>
          <dt>메모리 사용률</dt>
          <dd>{viewModel.memoryPercent}%</dd>
          <dt>여유 디스크</dt>
          <dd>{viewModel.freeDiskBytes} bytes</dd>
        </dl>
      </section>
    </>
  );
}
