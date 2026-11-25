// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const auth=vi.hoisted(()=>({getSession:vi.fn(),onAuthStateChange:vi.fn(),signInWithPassword:vi.fn()}));
vi.mock('./lib/client',()=>({configured:true,apiUrl:'',db:{auth},ownerApi:vi.fn()}));
import App from './App';
beforeEach(()=>{vi.clearAllMocks();auth.getSession.mockResolvedValue({data:{session:null},error:null});auth.onAuthStateChange.mockReturnValue({data:{subscription:{unsubscribe:vi.fn()}}});auth.signInWithPassword.mockResolvedValue({data:{session:null},error:{message:'Invalid login credentials'}});});
afterEach(()=>cleanup());
describe('private account login',()=>{it('offers password login without public registration or demo metrics',async()=>{render(<App/>);await waitFor(()=>expect(screen.getByRole('button',{name:'Sign in securely'})).toBeTruthy());expect(screen.queryByRole('button',{name:/sign up|register/i})).toBeNull();expect(screen.queryByText('Processor utilization')).toBeNull();expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password');});it('passes credentials only to Supabase and clears the password after a rejected attempt',async()=>{render(<App/>);await waitFor(()=>expect(screen.getByLabelText('Email address')).toBeTruthy());fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'owner@example.com'}});fireEvent.change(screen.getByLabelText('Password'),{target:{value:'test-password'}});fireEvent.click(screen.getByRole('button',{name:'Sign in securely'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Invalid login credentials'));expect(auth.signInWithPassword).toHaveBeenCalledWith({email:'owner@example.com',password:'test-password'});expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');});});
