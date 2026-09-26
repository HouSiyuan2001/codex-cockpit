// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudSyncSettings } from './CloudSyncSettings';
const api=vi.hoisted(()=>({invoke:vi.fn(),status:vi.fn(),sync:vi.fn()}));
vi.mock('../lib/bridge',()=>({isTauri:()=>true}));
vi.mock('@tauri-apps/api/core',()=>({invoke:api.invoke}));
vi.mock('../lib/usageSyncBridge',()=>({getUsageSyncStatus:api.status,syncUsageNow:api.sync}));
beforeEach(()=>{api.invoke.mockReset().mockResolvedValue({config:null,members:[]});api.status.mockReset().mockResolvedValue({settings:{deviceId:'Windows-Test'},phase:'idle'});api.sync.mockReset().mockResolvedValue({phase:'idle',lastError:null});});
afterEach(cleanup);
it('Windows enrollment retains the existing ID without auto-joining or displaying the Mac keychain action',async()=>{
 render(<CloudSyncSettings usage={null} zh onSynced={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByLabelText('本机设备标识')).toHaveValue('Windows-Test'));
 expect(screen.queryByText('接入已有云空间')).not.toBeInTheDocument();
 expect(api.invoke.mock.calls.every(([command])=>command==='get_cloud_sync_status')).toBe(true);
 expect(api.sync).not.toHaveBeenCalled();
 expect(screen.getByText(/加入后，这台电脑的用量会同步给其他设备/)).toBeInTheDocument();
});
it('reports device mismatch safely and does not call sync after rejected enrollment',async()=>{
 api.invoke.mockImplementation(async(command:string)=>{if(command==='connect_cloud_sync')throw 'cloud_identity_mismatch private-detail';return {config:null,members:[],canConnectExisting:false};});
 render(<CloudSyncSettings usage={null} zh onSynced={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByLabelText('本机设备标识')).toHaveValue('Windows-Test'));
 fireEvent.change(screen.getByLabelText('邀请码'),{target:{value:'synthetic-invite'}});
 fireEvent.change(screen.getByLabelText('显示名称'),{target:{value:'Test'}});
 fireEvent.submit(screen.getByLabelText('邀请码').closest('form')!);
 expect(await screen.findByRole('alert')).toHaveTextContent('请沿用本机设备标识');
 expect(screen.queryByText(/private-detail/)).not.toBeInTheDocument();
 expect(api.sync).not.toHaveBeenCalled();
});
it('requires a chosen endpoint and keeps task details private by default',async()=>{
 render(<CloudSyncSettings usage={null} zh onSynced={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByLabelText('本机设备标识')).toHaveValue('Windows-Test'));
 expect(screen.getByLabelText('服务地址')).toHaveValue('');
 expect(screen.getByLabelText('共享任务名称和项目名称（可选）')).not.toBeChecked();
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://example.workers.dev'}});
 fireEvent.change(screen.getByLabelText('显示名称'),{target:{value:'Example'}});
 fireEvent.click(screen.getByRole('button',{name:'创建共享空间'}));
 fireEvent.change(screen.getByLabelText('空间名称'),{target:{value:'My team'}});
 fireEvent.change(screen.getByLabelText('建站密钥'),{target:{value:'synthetic-setup-secret'}});
 expect(screen.getByLabelText('建站密钥')).toHaveAttribute('type','password');
 fireEvent.submit(screen.getByLabelText('建站密钥').closest('form')!);
 await waitFor(()=>expect(api.invoke).toHaveBeenCalledWith('connect_cloud_sync',{setup:{endpoint:'https://example.workers.dev',displayName:'Example',deviceId:'Windows-Test',spaceName:'My team',bootstrapSecret:'synthetic-setup-secret',inviteCode:null,shareTaskDetails:false}}));
 await waitFor(()=>expect(api.sync).toHaveBeenCalledTimes(1));
 expect(screen.getByLabelText('建站密钥')).toHaveValue('');
});
