import {Fields} from './Shared';
// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import {Empty,QueryState} from './ui/primitives';
afterEach(()=>cleanup());
describe('measurement states',()=>{it('shows errors as alerts without rendering stale readings',()=>{render(<QueryState loading={false} error="Access denied"><div>42% CPU</div></QueryState>);expect(screen.getByRole('alert').textContent).toContain('Access denied');expect(screen.queryByText('42% CPU')).toBeNull();});it('shows unreported state without fake values',()=>{render(<Empty title="No observations"/>);expect(screen.getByText('No observations')).toBeTruthy();expect(screen.queryByText('0%')).toBeNull();});it('announces pending queries',()=>{render(<QueryState loading><div>data</div></QueryState>);expect(screen.getByRole('status')).toBeTruthy();});});

it('renders an unreported service state as Unknown rather than stopped',()=>{render(<Fields value={{dnsmasq:null}}/>);expect(screen.getByText('Unknown')).toBeTruthy();expect(screen.queryByText('false')).toBeNull();});
