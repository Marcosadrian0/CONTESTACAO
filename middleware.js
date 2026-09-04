// Middleware de borda da Vercel. Roda antes de qualquer resposta — página estática ou
// função serverless — em todas as rotas do projeto. Bloqueia qualquer requisição que não
// venha de um dos IPs autorizados, para restringir o acesso ao painel só à rede do
// escritório enquanto o sistema ainda está em fase de teste.
//
// A lista de IPs pode ser sobrescrita sem alterar este arquivo: configure a variável de
// ambiente ALLOWED_IPS (lista separada por vírgula) em Project Settings > Environment
// Variables na Vercel e faça um redeploy. Sem essa variável, usa os dois IPs padrão abaixo.
export const config = {
  matcher: '/:path*',
};

const IPS_PADRAO = ['186.193.236.194', '179.191.112.34'];

function listaPermitida() {
  const env = process.env.ALLOWED_IPS;
  if (!env) return IPS_PADRAO;
  return env.split(',').map(ip => ip.trim()).filter(Boolean);
}

function extrairIp(request) {
  const encaminhado = request.headers.get('x-forwarded-for');
  if (encaminhado) return encaminhado.split(',')[0].trim();
  return request.headers.get('x-real-ip');
}

export default function middleware(request) {
  const ip = extrairIp(request);
  const permitidos = listaPermitida();

  if (!ip || !permitidos.includes(ip)) {
    return new Response(
      'Acesso restrito: este endereço IP não está autorizado a acessar este sistema.\n',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }
  // IP autorizado: não retornar nada deixa a requisição seguir normalmente
  // para a página estática ou a função serverless de destino.
}
