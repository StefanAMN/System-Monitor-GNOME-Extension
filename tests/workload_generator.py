#!/usr/bin/env python3
"""
Resource Pulse - Controlled Synthetic Workload Generator
Spawns deterministic and dynamically varying CPU, Memory, and Disk I/O loads.
"""

import sys
import os
import time
import signal
import argparse
import multiprocessing as mp

try:
    mp.set_start_method('fork')
except RuntimeError:
    pass

# Global list of worker processes / allocated memory for clean shutdown
_cpu_workers = []
_memory_buffers = []
_disk_file_path = "/var/tmp/rp_benchmark_io.tmp"
_stop_disk = None
_disk_process = None

import ctypes

def _set_pdeathsig():
    try:
        ctypes.CDLL("libc.so.6").prctl(1, 15)
    except Exception:
        pass

def _cpu_busy_loop(stop_event, duty_cycle=100):
    """Burn CPU on a single core at the specified duty cycle (1-100%)."""
    _set_pdeathsig()
    if duty_cycle >= 100:
        while not stop_event.is_set():
            for _ in range(1000000):
                pass
        return

    period = 0.05  # 50ms time window
    busy_time = period * (duty_cycle / 100.0)
    sleep_time = period - busy_time

    while not stop_event.is_set():
        start = time.time()
        while time.time() - start < busy_time:
            for _ in range(10000):
                pass
        if sleep_time > 0.001:
            time.sleep(sleep_time)

def set_cpu_load(cores, duty_cycle=100):
    """Start or stop CPU worker processes to match desired core count."""
    global _cpu_workers
    # Terminate existing
    for p, stop_ev in _cpu_workers:
        stop_ev.set()
        p.join(timeout=0.5)
        if p.is_alive():
            p.terminate()
    _cpu_workers = []

    # Spawn new workers
    for _ in range(cores):
        stop_ev = mp.Event()
        p = mp.Process(target=_cpu_busy_loop, args=(stop_ev, duty_cycle))
        p.daemon = True
        p.start()
        _cpu_workers.append((p, stop_ev))

import mmap

_mem_queue = None
_mem_process = None

def _mem_worker_loop(queue):
    _set_pdeathsig()
    m = None
    while True:
        try:
            target_mb = queue.get()
        except Exception:
            break
        if target_mb < 0:
            if m is not None:
                try: m.close()
                except Exception: pass
            break
        if m is not None:
            try: m.close()
            except Exception: pass
            m = None
        if target_mb > 0:
            total_bytes = target_mb * 1024 * 1024
            m = mmap.mmap(-1, total_bytes, mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS)
            chunk = b"\xbb" * (1024 * 1024)
            for _ in range(target_mb):
                m.write(chunk)

def set_memory_load(target_mb):
    """Allocate and dirty RAM in an isolated worker process for clean OS page reclamation."""
    global _mem_queue, _mem_process
    if _mem_process is None or not _mem_process.is_alive():
        _mem_queue = mp.Queue()
        _mem_process = mp.Process(target=_mem_worker_loop, args=(_mem_queue,))
        _mem_process.daemon = True
        _mem_process.start()
    _mem_queue.put(target_mb)

def _disk_io_worker(stop_event, target_mb_s, file_path):
    """Write to file at throttled rate with fdatasync."""
    _set_pdeathsig()
    chunk_size = 1024 * 1024  # 1 MB
    data = b"\xcc" * chunk_size
    try:
        with open(file_path, "wb") as f:
            while not stop_event.is_set():
                t0 = time.time()
                f.write(data)
                f.flush()
                os.fdatasync(f.fileno())
                elapsed = time.time() - t0
                sleep_time = (1.0 / max(1, target_mb_s)) - elapsed
                if sleep_time > 0 and not stop_event.is_set():
                    time.sleep(sleep_time)
                # Rewind if file exceeds 150 MB to prevent filling up drive
                if f.tell() > 150 * 1024 * 1024:
                    f.seek(0)
    except Exception:
        pass

def set_disk_load(target_mb_s):
    """Start or stop throttled disk write worker."""
    global _disk_process, _stop_disk
    if _disk_process and _disk_process.is_alive():
        _stop_disk.set()
        _disk_process.join(timeout=0.5)
        if _disk_process.is_alive():
            _disk_process.terminate()
        _disk_process = None
        _stop_disk = None

    if target_mb_s > 0:
        _stop_disk = mp.Event()
        _disk_process = mp.Process(target=_disk_io_worker, args=(_stop_disk, target_mb_s, _disk_file_path))
        _disk_process.daemon = True
        _disk_process.start()

def cleanup(signum=None, frame=None):
    """Clean up all processes, memory, and files."""
    set_cpu_load(0)
    set_disk_load(0)
    global _mem_queue, _mem_process
    if _mem_queue is not None:
        try: _mem_queue.put(-1)
        except Exception: pass
    if _mem_process and _mem_process.is_alive():
        _mem_process.join(timeout=0.5)
        if _mem_process.is_alive():
            _mem_process.terminate()
        _mem_process = None
        _mem_queue = None

    if os.path.exists(_disk_file_path):
        try:
            os.remove(_disk_file_path)
        except OSError:
            pass
    sys.exit(0)

def run_dynamic_sequence():
    """Run a time-varying sequence testing step changes and recovery."""
    phases = [
        {"name": "BASELINE", "duration": 2.5, "cpu_cores": 0, "mem_mb": 0, "disk_mbs": 0},
        {"name": "HIGH_LOAD", "duration": 4.0, "cpu_cores": 2, "mem_mb": 600, "disk_mbs": 25},
        {"name": "STEP_DOWN", "duration": 4.0, "cpu_cores": 1, "mem_mb": 300, "disk_mbs": 10},
        {"name": "RECOVERY", "duration": 3.0, "cpu_cores": 0, "mem_mb": 0, "disk_mbs": 0},
    ]

    print(f"[DYNAMIC_START] phases={len(phases)}", flush=True)
    for p in phases:
        print(f"[PHASE_START] name={p['name']} duration={p['duration']} cpu_cores={p['cpu_cores']} mem_mb={p['mem_mb']} disk_mbs={p['disk_mbs']}", flush=True)
        set_cpu_load(p["cpu_cores"])
        set_memory_load(p["mem_mb"])
        set_disk_load(p["disk_mbs"])
        time.sleep(p["duration"])
        print(f"[PHASE_END] name={p['name']}", flush=True)

    print("[DYNAMIC_END]", flush=True)
    cleanup()

def main():
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    parser = argparse.ArgumentParser(description="Resource Pulse Workload Generator")
    parser.add_argument("--dynamic", action="store_true", help="Run dynamic time-varying stepped load sequence")
    parser.add_argument("--cpu-cores", type=int, default=0, help="Number of CPU cores to saturate")
    parser.add_argument("--cpu-duty", type=int, default=100, help="CPU duty cycle (1-100%%)")
    parser.add_argument("--mem-mb", type=int, default=0, help="Megabytes of RAM to allocate and hold")
    parser.add_argument("--disk-mbs", type=int, default=0, help="Throttled disk write rate in MB/s")
    parser.add_argument("--duration", type=float, default=5.0, help="Duration to sustain steady load in seconds")
    parser.add_argument("--ready-file", type=str, default="", help="Touch this file when workload is ready")
    args = parser.parse_args()

    if args.dynamic:
        run_dynamic_sequence()
        return

    # Steady-state workload
    if args.cpu_cores > 0:
        set_cpu_load(args.cpu_cores, args.cpu_duty)
    if args.mem_mb > 0:
        set_memory_load(args.mem_mb)
    if args.disk_mbs > 0:
        set_disk_load(args.disk_mbs)

    if args.ready_file:
        try:
            with open(args.ready_file, "w") as rf:
                rf.write(f"PID={os.getpid()}\n")
        except OSError:
            pass

    print(f"[STEADY_START] pid={os.getpid()} cpu_cores={args.cpu_cores} mem_mb={args.mem_mb} disk_mbs={args.disk_mbs} duration={args.duration}", flush=True)
    time.sleep(args.duration)
    print(f"[STEADY_END] pid={os.getpid()}", flush=True)
    cleanup()

if __name__ == "__main__":
    main()
