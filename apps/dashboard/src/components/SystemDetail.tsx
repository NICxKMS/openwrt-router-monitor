import { bytes, fmt, mib, num, object, rows, sentenceCase, type Row } from '../lib/model';
import { CollectorLag, DataTable } from './Shared';
import { Card, Empty } from './ui/primitives';

const cpuStates = [
  ['user', 'User'], ['nice', 'Low priority'], ['system', 'Kernel'], ['idle', 'Idle'],
  ['iowait', 'I/O wait'], ['irq', 'Hardware IRQ'], ['softirq', 'Software IRQ'],
  ['steal', 'Steal'], ['guest', 'Guest'], ['guest_nice', 'Low-priority guest'],
];

export function CpuBreakdown({ detail }: { detail: Row }) {
  const cpu = object(detail.cpu);
  const modes = object(cpu.modes);
  const cores = Object.entries(object(cpu.core_modes));
  const scheduler = object(cpu.scheduler);
  const frequencies = rows(detail.cpu_frequency);
  const softirq = object(detail.cpu_softirq);
  const tasks = rows(detail.processes_cpu);

  if (!Object.keys(modes).length && !Object.keys(scheduler).length && !tasks.length) return null;
  return (
    <>
      <Card title="CPU time by state" description="Percent of elapsed CPU time since the previous sample.">
        {Object.keys(modes).length ? (
          <DataTable
            data={cpuStates.map(([key, state], index) => ({
              state, total: modes[key],
              ...Object.fromEntries(cores.map(([core, values]) => [core, Array.isArray(values) ? values[index] : undefined])),
            }))}
            columns={[
              { key: 'state', label: 'State' },
              { key: 'total', label: 'All cores', render: (value) => fmt(value, '%', 1) },
              ...cores.map(([key]) => ({
                key, label: key.toUpperCase(), render: (value: unknown) => fmt(value, '%', 1),
              })),
            ]}
          />
        ) : <Empty title="Waiting for a second CPU sample" />}
      </Card>
      <div className="two-col">
        <Card title="Top tasks by CPU" description="Share of total machine CPU between process samples. Short-lived tasks may finish between samples." action={<CollectorLag uptimeKey="processes_uptime_s" label="Tasks" />}>
          {tasks.length ? <DataTable data={tasks.map((task) => ({ ...task, id: String(task.pid) }))} columns={[
            { key: 'name', label: 'Task' },
            { key: 'pid', label: 'PID' },
            { key: 'cpu_pct', label: 'CPU', render: (value) => fmt(value, '%', 1) },
          ]} /> : <Empty title="No task CPU interval yet" />}
        </Card>
        <Card title="Scheduler and interrupts" description="Runnable and blocked tasks are current counts. Other counters accumulate since boot.">
          <DataTable data={[
            ...[
              ['procs_running', 'Runnable tasks'], ['procs_blocked', 'Tasks blocked on I/O'],
              ['ctxt', 'Context switches'], ['intr', 'Hardware interrupts'],
              ['softirq', 'Software interrupts'], ['processes', 'Tasks created'],
            ].filter(([key]) => scheduler[key] != null).map(([key, label]) => ({ label, count: scheduler[key] })),
            ...Object.entries(softirq).map(([label, count]) => ({ label, count })),
          ]} columns={[{ key: 'label', label: 'Counter' }, { key: 'count', label: 'Count' }]} />
        </Card>
      </div>
      {frequencies.length > 0 && <Card title="CPU frequency" action={<CollectorLag uptimeKey="detail_uptime_s" label="Frequency" />}>
        <DataTable data={frequencies} columns={[
          { key: 'policy', label: 'Policy' },
          ...[['cur', 'Reported'], ['min', 'Minimum'], ['max', 'Maximum']].map(([field, label]) => ({
            key: `scaling_${field}_freq`, label,
            render: (value: unknown) => { const khz = num(value); return khz === null ? '—' : fmt(khz / 1000, ' MHz', 0); },
          })),
        ]} />
      </Card>}
    </>
  );
}

const accountingLabels: Record<string, string> = {
  total: 'Linux-managed RAM',
  free: 'Free pages',
  anonymous: 'Anonymous process pages',
  shared_and_tmpfs: 'Shared memory and tmpfs',
  file_cache: 'File cache excluding shared memory',
  block_buffers: 'Block buffers',
  slab: 'Slab caches',
  other_reclaimable_kernel: 'Other reclaimable kernel memory',
  kernel_stacks: 'Kernel stacks',
  shadow_call_stacks: 'Shadow call stacks',
  page_tables: 'Page tables',
  secondary_page_tables: 'Secondary page tables',
  per_cpu: 'Per-CPU memory',
  hugetlb: 'Reserved huge pages',
  measured_categories: 'Sum of measured categories',
  counter_difference: 'Counter difference',
};

export function MemoryBreakdown({ memory }: { memory: Row }) {
  const accounting = object(memory.accounting_kb);
  const kernel = object(memory.kernel_kb);
  const dtRam = num(memory.dt_ram_bytes);
  const managed = num(accounting.total);
  const reservations = rows(memory.reservations);
  const zones = rows(memory.zones);
  const buddy = rows(memory.free_blocks);
  const slab = rows(memory.slab);
  const allocations = rows(memory.allocinfo);
  const zram = rows(memory.zram);
  const swap = object(memory.swap);
  const sockets = object(memory.sockets);

  if (!Object.keys(accounting).length) return null;
  return (
    <>
      <div className="two-col">
        <Card title="Linux RAM accounting" description="The counter difference shows RAM that these sampled categories cannot reconcile. A negative value can occur while the counters change." action={<CollectorLag uptimeKey="detail_uptime_s" label="RAM accounting" />}>
          <DataTable data={Object.entries(accountingLabels).flatMap(([key, label]) => (
            accounting[key] == null ? [] : [{ label, value: accounting[key] }]
          ))} columns={[{ key: 'label', label: 'Category' }, { key: 'value', label: 'Memory', render: (v) => { const kb = num(v); return bytes(kb === null ? null : kb * 1024); } }]} />
        </Card>
        <Card title="Firmware memory reservations" description="Regions declared in the running device tree. Reusable regions can also appear in Linux RAM counters.">
          {dtRam !== null && (
            <p>Device tree RAM {bytes(dtRam)}. {managed !== null && <>Difference from Linux-managed RAM {bytes(dtRam - managed * 1024)}.</>}</p>
          )}
          {reservations.length ? <DataTable data={reservations.map((region, index) => ({ ...region, id: region.id ?? `legacy-reservation-${index}` }))} columns={[
            { key: 'name', label: 'Region' },
            { key: 'bytes', label: 'Size', render: bytes },
            { key: 'no_map', label: 'Mapping', render: (value, row) => row.reusable ? 'Reusable' : value ? 'Excluded from linear map' : 'Reserved' },
          ]} /> : <Empty title="No named reservations reported" />}
        </Card>
      </div>
      <div className="two-col">
        <Card title="Kernel memory counters" description="These counters overlap other memory views.">
          <DataTable data={Object.entries(kernel).map(([counter, value]) => ({ counter, value }))} columns={[
            { key: 'counter', label: 'Counter' }, { key: 'value', label: 'Memory', render: (v) => { const kb = num(v); return bytes(kb === null ? null : kb * 1024); } },
          ]} />
        </Card>
        <Card title="Free page blocks" description={`Counts by block order, starting at order 0. Base page size ${num(memory.page_kb) ?? 'unknown'} KiB.`}>
          {zones.length ? <DataTable data={zones.map((zone) => ({ ...zone, ...buddy.find((row) => row.zone === zone.zone) }))} columns={[
            { key: 'zone', label: 'Zone' }, { key: 'present', label: 'Present pages' }, { key: 'managed', label: 'Managed pages' },
            { key: 'free', label: 'Free pages' }, { key: 'min', label: 'Minimum' }, { key: 'low', label: 'Low' }, { key: 'high', label: 'High' },
            { key: 'blocks_by_order', label: 'Free blocks by order', render: (v) => Array.isArray(v) ? v.join(' / ') : '—' },
          ]} /> : <Empty title="Page-zone counters unavailable" />}
        </Card>
      </div>
      <div className="two-col">
        <Card title="Largest slab caches" description="Backing pages include capacity that is currently unused.">
          {slab.length ? <DataTable data={slab} columns={[
            { key: 'name', label: 'Cache' }, { key: 'allocated_bytes', label: 'Backing RAM', render: bytes },
            { key: 'active_object_bytes', label: 'Live objects', render: bytes },
          ]} /> : <Empty title="Slab cache sizes unavailable" />}
        </Card>
        <Card title="Largest kernel allocation sites" description="Largest accurately tracked allocations by source line. Allocation-site and slab totals can overlap.">
          {allocations.length ? <DataTable data={allocations} columns={[
            { key: 'name', label: 'Source line', render: (value) => <code style={{ overflowWrap: 'anywhere' }}>{String(value)}</code> },
            { key: 'allocated_bytes', label: 'Live allocation', render: bytes },
            { key: 'allocations', label: 'Count' },
          ]} /> : <Empty title="No allocation sites reported" />}
        </Card>
      </div>
      <div className="two-col">
        <Card title="Swap and compressed RAM" description={`Swap capacity ${mib(num(swap.total_kb))}. Free swap ${mib(num(swap.free_kb))}.`}>
          {zram.length ? <DataTable data={zram} columns={[
            { key: 'name', label: 'Device' }, { key: 'original_bytes', label: 'Original data', render: bytes },
            { key: 'compressed_bytes', label: 'Compressed data', render: bytes },
            { key: 'allocated_bytes', label: 'Actual RAM', render: bytes },
            { key: 'peak_bytes', label: 'Peak RAM', render: bytes },
          ]} /> : <Empty title="No zram device reported" />}
        </Card>
        <Card title="Network socket memory" description="TCP and UDP memory counters are in pages. Fragment memory is in bytes.">
          <DataTable data={Object.entries(sockets).map(([name, entry]) => ({ name: sentenceCase(name), ...object(entry) }))} columns={[
            { key: 'name', label: 'Socket class' }, { key: 'inuse', label: 'In use' }, { key: 'used', label: 'Sockets' },
            { key: 'mem', label: 'Pages' }, { key: 'memory', label: 'Fragment memory', render: bytes },
          ]} />
        </Card>
      </div>
    </>
  );
}
