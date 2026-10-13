# Measurement: TS AT engine against the real module

Date: 2026-09-29 · Board: Calliope mini 3 · Module: ESP32-C3, ESP-AT 3.3.0.0 · Port: `serial.redirect` (SerialPort)
Program: `tools/hil/spikes/tsengine/program.ts` (snapshot copy of `wlanat.ts` / `wlanport.ts`), run with `hil.py run`.

```
sync=true ate0=true
caps family=2 ver=3.3.0.0 httpClient=true passive=true tls=true sysstore=true
CWSTATE code=OK lines=+CWSTATE:2,"Werkstatt-WLAN"
CWJAP code=OK
HTTPS GET code=OK payload(51)={"message":"API is healthy.","code":200,"data":{}}
HTTPCPOST code=OK payload(227)={"cur":7612,"n":1,"ok":1,"rej":0,"ts":…,"w":[…]}
RECVMODE=1 OK · CIPSTART OK · CIPSEND OK (Recv 277 bytes)
passivePending=295 linkOpen=true
passive pulled 295 bytes; tail=…{"error":"too_fast","ok":0,"retry_after":1}
counters: urcs=7 lost=0 busy=0 stale=0 resets=0
urc WIFI DISCONNECT · WIFI CONNECTED · WIFI GOT IP · CONNECT · +IPD,295 · +IPD,95 · CLOSED
```

- Capability detection, URC routing (join URCs never mixed into command results), length-framed payloads
  (HTTPCLIENT 51 B, HTTPCPOST 227 B) and passive receive all behave as the Node tests specify.
- The 429 is the server's per-device limit (900 ms): the test sent two POSTs as dev -779 within a second. The
  engine read the error body completely. The IoT core must keep the ≥ 1 s WLAN floor per device.
- Open: why a second `+IPD,95` notification follows the first (`+IPD,295`) — check whether passive mode reports
  the remaining length again after a partial pull; harmless here (all 295 bytes were pulled, nothing lost).
