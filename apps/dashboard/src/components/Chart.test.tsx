// @vitest-environment jsdom
import React from 'react';
import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({setOption:vi.fn(),dispose:vi.fn()}));
vi.mock('echarts/core',()=>({use:vi.fn(),init:()=>({setOption:mock.setOption,dispose:mock.dispose,resize:vi.fn()})}));
vi.mock('echarts/charts',()=>({LineChart:{}}));
vi.mock('echarts/components',()=>({DataZoomComponent:{},GridComponent:{},TooltipComponent:{},LegendComponent:{},AxisPointerComponent:{}}));
vi.mock('echarts/renderers',()=>({CanvasRenderer:{}}));
vi.mock('../lib/data',()=>({useMonitor:()=>({zone:'Asia/Kolkata',theme:'dark'})}));
import Chart from './Chart';
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('configures the tooltip and crosshair header in the display timezone',()=>{render(<Chart data={[]} metric="cpu_pct"/>);const option=mock.setOption.mock.calls[0][0];const formatted=option.xAxis.axisPointer.label.formatter({value:Date.parse('2026-11-25T00:00:00Z')});expect(formatted).toContain('5:30:00');expect(formatted).toContain('25 Nov 2026');});
