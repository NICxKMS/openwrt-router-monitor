import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({api:vi.fn(),refresh:vi.fn(),deviceId:'device-a',intervals:{} as Record<string,number>,clients:[] as {client_id:string;name:string}[]}));
vi.mock('../lib/client',()=>({ownerApi:mock.api,db:{from:(table:string)=>{const b:Record<string,unknown>={then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:table==='client_names'?mock.clients:[],error:null}).then(resolve)};for(const key of ['select','eq','order','limit'])b[key]=()=>b;return b;}}}));
vi.mock('../lib/data',async importOriginal=>({...await importOriginal<typeof import('../lib/data')>(),useMonitor:()=>({device:{id:mock.deviceId,name:'Home',config:{buffer_kb:4096,privacy_addresses:true,log_severity:7,diagnostics_enabled:true,logs_enabled:false,sample_interval:30,...mock.intervals}},tick:0,zone:'Asia/Kolkata',setZone:vi.fn(),theme:'dark',setTheme:vi.fn(),refreshSeconds:30,setRefreshSeconds:vi.fn(),refresh:mock.refresh})}));
import {Enrollment,Settings} from './Settings';
import {ActionProvider} from '../components/Actions';
beforeEach(()=>{mock.deviceId='device-a';mock.intervals={};mock.clients=[];});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();});
it('keeps router-local controls read-only and excludes them from cloud saves',async()=>{mock.api.mockResolvedValue({ok:true});render(<Settings/>);expect((screen.getByLabelText('Memory queue limit') as HTMLInputElement).readOnly).toBe(true);expect((screen.getByLabelText('Log severity threshold') as HTMLInputElement).readOnly).toBe(true);expect((screen.getByLabelText('Address privacy') as HTMLInputElement).readOnly).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Save collection settings'}));await waitFor(()=>expect(mock.api).toHaveBeenCalledWith('/api/v1/devices/device-a/config',{diagnostics_enabled:true,logs_enabled:false,sample_interval:30},'POST',expect.anything()));expect(screen.getByText(/Enabling either here also requires permission/)).toBeTruthy();});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
it('does not reveal a previous router credential after switching routers during rotation',async()=>{const response=deferred<{token:string}>();mock.api.mockReturnValue(response.promise);const view=render(<ActionProvider><Settings/></ActionProvider>);fireEvent.click(screen.getByRole('button',{name:'Rotate device credential'}));await waitFor(()=>expect(mock.api).toHaveBeenCalled());mock.deviceId='device-b';view.rerender(<ActionProvider><Settings/></ActionProvider>);const secret='nxd_'+('f'.repeat(64));await act(async()=>response.resolve({token:secret}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('previous router credential was rotated'));expect(screen.queryByDisplayValue(secret)).toBeNull();expect(document.body.textContent).not.toContain(secret);});
it('does not restore an enrollment secret when its dialog closes before the response',async()=>{const response=deferred<{token:string;expires_at:string}>();mock.api.mockReturnValue(response.promise);render(<ActionProvider><Enrollment/></ActionProvider>);fireEvent.click(screen.getByRole('button',{name:'Add router'}));fireEvent.change(screen.getByLabelText('Router name'),{target:{value:'Home'}});fireEvent.click(screen.getByRole('button',{name:'Create enrollment code'}));await waitFor(()=>expect(mock.api).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:'Close'}));fireEvent.click(screen.getByRole('button',{name:'Add router'}));const secret='nxe_'+('f'.repeat(64));await act(async()=>response.resolve({token:secret,expires_at:'2026-11-25T12:00:00Z'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('created after this dialog closed'));expect(screen.queryByDisplayValue(secret)).toBeNull();expect(screen.queryByLabelText('One-use enrollment code')).toBeNull();});

it('suppresses a credential result arriving after its action deadline',async()=>{vi.useFakeTimers();const response=deferred<{token:string}>();mock.api.mockReturnValue(response.promise);render(<ActionProvider><Settings/></ActionProvider>);fireEvent.click(screen.getByRole('button',{name:'Rotate device credential'}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});const signal=mock.api.mock.calls[0][3] as AbortSignal;await act(async()=>{await vi.advanceTimersByTimeAsync(20001);});expect(signal.aborted).toBe(true);const secret='nxd_'+('e'.repeat(64));await act(async()=>response.resolve({token:secret}));expect(screen.queryByDisplayValue(secret)).toBeNull();expect(screen.getByRole('alert').textContent).toContain('Could not confirm completion');});

it('submits populated client-name fields while the form is pending',async()=>{mock.api.mockResolvedValue({ok:true});render(<ActionProvider><Settings/></ActionProvider>);fireEvent.change(screen.getByLabelText('Local client identifier'),{target:{value:'client_123'}});fireEvent.change(screen.getByPlaceholderText('Living room laptop'),{target:{value:'Laptop'}});fireEvent.click(screen.getByRole('button',{name:'Save client name'}));await waitFor(()=>expect(mock.api).toHaveBeenCalledWith('/api/v1/devices/device-a/client-names/client_123',{name:'Laptop'},'PUT',expect.anything()));});
it('submits an edited name from an existing client row',async()=>{mock.clients=[{client_id:'client_123',name:'Old name'}];mock.api.mockResolvedValue({ok:true});render(<ActionProvider><Settings/></ActionProvider>);const input=await screen.findByLabelText('Name for client_123');fireEvent.change(input,{target:{value:'New name'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(mock.api).toHaveBeenCalledWith('/api/v1/devices/device-a/client-names/client_123',{name:'New name'},'PUT',expect.anything()));});

it('keeps legacy collection settings editable within the agent limits', async () => {
  mock.intervals={wifi_interval:1200,process_interval:2400};
  mock.api.mockResolvedValue({ok:true});
  render(<Settings/>);
  const wifi=screen.getByLabelText('Wi-Fi interval (s)') as HTMLInputElement;
  const processes=screen.getByLabelText('Process interval (s)') as HTMLInputElement;
  expect(wifi.value).toBe('900');
  expect(processes.value).toBe('1800');
  expect(wifi.form?.checkValidity()).toBe(true);
  fireEvent.change(screen.getByLabelText('Sample interval (s)'),{target:{value:'20'}});
  fireEvent.click(screen.getByRole('button',{name:'Save collection settings'}));
  await waitFor(()=>expect(mock.api).toHaveBeenCalledWith('/api/v1/devices/device-a/config',
    {diagnostics_enabled:true,logs_enabled:false,sample_interval:20,wifi_interval:900,process_interval:1800},
    'POST',expect.anything()));
});
