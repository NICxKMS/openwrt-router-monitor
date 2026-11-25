// @vitest-environment jsdom
import React from 'react';
import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({setOption:vi.fn(),dispose:vi.fn(),connect:vi.fn(),on:vi.fn(),getOption:vi.fn(),instances:[] as Array<{group?:string}>}));
vi.mock('echarts/core',()=>({use:vi.fn(),connect:mock.connect,init:()=>{const inst={group:undefined as string|undefined,setOption:mock.setOption,dispose:mock.dispose,resize:vi.fn(),on:mock.on,getOption:mock.getOption};mock.instances.push(inst);return inst;}}));
vi.mock('echarts/charts',()=>({LineChart:{}}));
vi.mock('echarts/components',()=>({DataZoomComponent:{},GridComponent:{},TooltipComponent:{},LegendComponent:{},AxisPointerComponent:{}}));
vi.mock('echarts/renderers',()=>({CanvasRenderer:{}}));
vi.mock('../lib/data',()=>({useMonitor:()=>({zone:'Asia/Kolkata',theme:'dark'})}));
import Chart from './Chart';
beforeEach(()=>{vi.clearAllMocks();mock.instances.length=0;vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('configures the tooltip and crosshair header in the display timezone',()=>{render(<Chart data={[]} metric="cpu_pct"/>);const option=mock.setOption.mock.calls[0][0];const formatted=option.xAxis.axisPointer.label.formatter({value:Date.parse('2026-11-25T00:00:00Z')});expect(formatted).toContain('5:30:00');expect(formatted).toContain('25 Nov 2026');});
it('connects overview telemetry charts in one group and isolates firmware comparison charts',()=>{render(<><Chart data={[]} metric="cpu_pct"/><Chart data={[]} metric="temp_c"/><Chart data={[]} metric="cpu_pct" compare={{baseline:[],comparison:[],metric:'cpu_pct'}}/></>);expect(mock.instances[0].group).toBe('telemetry');expect(mock.instances[1].group).toBe('telemetry');expect(mock.instances[2].group).toBe('compare');expect(mock.connect).toHaveBeenCalledWith('telemetry');expect(mock.connect).toHaveBeenCalledWith('compare');});
