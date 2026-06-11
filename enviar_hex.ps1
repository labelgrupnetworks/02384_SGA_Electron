# Envia una trama HEX por TCP y muestra la respuesta.
# Uso: .\enviar_hex.ps1
# Trama: 30 03 32 35 34 03 30 30 31 03 49 21 47 58 30 36 0D 0A  (termina en CRLF)

$ip   = '10.32.230.18'
$port = 10051
$bytes = [byte[]](0x30,0x03,0x32,0x35,0x34,0x03,0x30,0x30,0x31,0x03,0x49,0x21,0x47,0x58,0x30,0x36,0x0D,0x0A)

$client = New-Object System.Net.Sockets.TcpClient
try {
    # Conectar con timeout de 5s
    $iar = $client.BeginConnect($ip, $port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(5000, $false)) { throw "Timeout de conexion (5s)" }
    $client.EndConnect($iar)
    Write-Host "Conectado a $ip`:$port" -ForegroundColor Green

    # Enviar
    $stream = $client.GetStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $hexOut = ($bytes | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
    Write-Host ("Enviados {0} bytes: {1}" -f $bytes.Length, $hexOut)

    # Leer respuesta (timeout 5s)
    $stream.ReadTimeout = 5000
    $buffer = New-Object byte[] 1024
    try {
        $n = $stream.Read($buffer, 0, $buffer.Length)
        if ($n -gt 0) {
            $resp = $buffer[0..($n - 1)]
            $hexIn = ($resp | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
            Write-Host ("Respuesta ({0} bytes) hex  : {1}" -f $n, $hexIn) -ForegroundColor Cyan
            Write-Host ("Respuesta ascii            : {0}" -f [System.Text.Encoding]::GetEncoding(28591).GetString($resp)) -ForegroundColor Cyan
        } else {
            Write-Host "Conexion cerrada sin datos."
        }
    } catch {
        Write-Host ("Sin respuesta: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    }
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
} finally {
    $client.Close()
    Write-Host "Conexion cerrada."
}
