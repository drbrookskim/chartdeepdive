---
name: technical-analysis-engine
description: 기본 기술적 지표(이동평균, RSI, MACD, 볼린저밴드) 계산 로직을 다룬다. 지표 수치 계산, 분석 결과 스키마 설계 작업에 사용. 차트 패턴 인식(헤드앤숄더, 삼각수렴 등)은 이 스킬이 아니라 `chart-pattern-recognition` 스킬을 사용할 것. 일목균형표/엘리엇파동/변곡점예측 같은 고급 기법은 별도 기존 스킬(ichimoku, elliott-wave, inflection-point-predictor)을 사용할 것.
---

# Technical Analysis Engine

## 이 스킬의 범위: 수치 지표만

이 스킬은 결정적(deterministic) 수식으로 계산되는 지표만 다룬다. 구조적 패턴 탐지(헤드앤숄더 등)는 `chart-pattern-recognition` 스킬로, 캔들스틱 단기 패턴은 `anthropic-skills:candlestick`으로, 일목균형표/엘리엇파동/변곡점예측은 각각의 기존 스킬로 분리되어 있다 — 계산 방식(수식 vs 형태 탐지)이 근본적으로 다르므로 섞지 않는다.

## 기본 지표

- **단순/지수 이동평균 (SMA/EMA)**: 기간 파라미터화 (5/20/60/120일 등 흔한 프리셋 제공)
- **RSI**: 표준 14기간, Wilder's smoothing 사용
- **MACD**: 12/26/9 기본값, `{macd, signal, histogram}` 세 값 모두 반환
- **볼린저 밴드**: 20기간 SMA ± 2 표준편차 기본값, `{upper, middle, lower}` 반환

지표는 결정적 계산이므로 반드시 실제 코드(파이썬/타입스크립트 등)로 구현하고 실행해서 검증한다. LLM이 수치를 추정하지 않는다.

## 출력 스키마 원칙

각 지표는 독립적으로 계산·반환 가능해야 한다. 프론트엔드가 RSI만 요청했는데 다른 지표까지 강제로 계산되는 구조를 만들지 않는다. 최종 스키마는 `technical-analysis-agent`가 `_workspace/02_technical-analysis-agent_output-schema.md`에 확정해 문서화하며, 이 스키마의 `indicators` 섹션이 이 스킬의 산출물이다.

## 데이터 부족 처리

지표 계산에 필요한 최소 기간(예: 120일 이동평균에는 최소 120개 캔들)이 확보되지 않으면 해당 지표만 `null`과 함께 부족 사유를 반환한다. 다른 지표까지 실패시키지 않는다.
