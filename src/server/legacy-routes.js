const net = require('node:net');

/**
 * Endpoints heredados, conservados para instalaciones que todavia no han
 * actualizado. Copia literal de lo que habia en main.js: cierran el socket 100 ms
 * despues de la primera rafaga y abren una conexion por comando. Es un contrato,
 * no un diseno: no mejorar nada aqui.
 */
function registerLegacyRoutes(expressApp, logger) {
    expressApp.post('/scale-command', async (req, res) => {
        logger.info('🔄 Petición POST recibida en /scale-command');
        logger.info('📋 Body recibido:', req.body);
        const { ip, port, command } = req.body;

        if (!ip || !port || !command) {
            return res.status(400).json({
                success: false,
                error: 'Faltan parámetros requeridos: ip, port, command',
            });
        }

        logger.info(`⚖️ [POST] Enviando comando a ${ip}:${port} → ${command}`);

        try {
            const client = new net.Socket();
            let response = '';

            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000);

                client.connect(port, ip, () => {
                    logger.info(`✅ [POST] Conectado a ${ip}:${port}`);
                    let fullCommand = command.endsWith('\r\n') ? command : command + '\r\n';
                    fullCommand = fullCommand.replace(/<ETX>/g, '\x03');
                    logger.info(`➡️ [POST] Enviando: ${JSON.stringify(fullCommand)}`);
                    client.write(fullCommand, 'ascii');
                });

                client.on('data', (data) => {
                    response += data.toString('ascii');
                    logger.info(`📥 [POST] Datos recibidos: ${JSON.stringify(response)}`);
                    setTimeout(() => {
                        client.end();
                    }, 100);
                });

                client.on('end', () => {
                    logger.info(`✅ [POST] Conexión terminada. Respuesta final: ${response}`);
                    const cleanResponse = response
                        .replace(/\x02/g, '<STX>')
                        .replace(/\x03/g, '<ETX>')
                        .trim();
                    logger.info(`🧹 [POST] Respuesta limpia: ${cleanResponse}`);
                    resolve({
                        success: true,
                        response: cleanResponse,
                        raw_response: response.trim(),
                    });
                });

                client.on('error', (err) => {
                    logger.error(`❌ [POST] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on('timeout', () => {
                    logger.warn('⏰ [POST] Timeout al comunicar');
                    client.destroy();
                    reject({ success: false, error: 'Timeout de conexión' });
                });
            });

            res.json(result);
        } catch (err) {
            logger.error(`❌ [POST] Excepción: ${err.message}`);
            res.status(500).json({
                success: false,
                error: err.error || err.message,
            });
        }
    });

    expressApp.post('/scale-hex', async (req, res) => {
        logger.info('🔄 Petición POST recibida en /scale-hex');
        const { ip, port, hex } = req.body;

        if (!ip || !port || !hex) {
            return res.status(400).json({
                success: false,
                error: 'Faltan parámetros requeridos: ip, port, hex',
            });
        }

        const clean = hex.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length % 2 !== 0) {
            return res.status(400).json({ success: false, error: 'HEX con longitud impar' });
        }
        const payload = Buffer.from(clean, 'hex');

        logger.info(`⚖️ [HEX] Enviando a ${ip}:${port} → ${payload.toString('hex').match(/../g).join(' ')}`);

        try {
            const client = new net.Socket();
            let response = Buffer.alloc(0);

            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000);

                client.connect(port, ip, () => {
                    logger.info(`✅ [HEX] Conectado a ${ip}:${port}`);
                    client.write(payload);
                });

                client.on('data', (data) => {
                    response = Buffer.concat([response, data]);
                    setTimeout(() => client.end(), 100);
                });

                client.on('end', () => {
                    const hexIn = response.toString('hex').match(/../g)?.join(' ') || '';
                    logger.info(`✅ [HEX] Respuesta (${response.length} bytes): ${hexIn}`);
                    resolve({
                        success: true,
                        response_hex: hexIn,
                        response_ascii: response.toString('latin1'),
                    });
                });

                client.on('error', (err) => {
                    logger.error(`❌ [HEX] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on('timeout', () => {
                    logger.warn('⏰ [HEX] Timeout al comunicar');
                    client.destroy();
                    reject({ success: false, error: 'Timeout de conexión' });
                });
            });

            res.json(result);
        } catch (err) {
            logger.error(`❌ [HEX] Excepción: ${err.message}`);
            res.status(500).json({ success: false, error: err.error || err.message });
        }
    });
}

module.exports = { registerLegacyRoutes };
