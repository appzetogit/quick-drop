/**
 * pm2 config for the SIDE-BY-SIDE super-app instance.
 *
 * This box runs 12 other pm2 apps, including `k9-backend` (/opt/k9, port 5005,
 * serving k9.appzeto.com) which is the LIVE pre-integration build of this same
 * project. Nothing here may collide with it:
 *
 *   name  k9-superapp-api   (live one is `k9-backend`)
 *   cwd   /opt/k9-superapp  (live one is /opt/k9)
 *   port  5007              (live one is 5005)
 *   db    set in .env       (must NOT be the live K9 database -- server.js seeds
 *                            on boot and the SP scheduler alerts vendors every 5s)
 *
 * Start:   pm2 start deploy/ecosystem.config.cjs
 * Reload:  pm2 reload k9-superapp-api
 * Never:   pm2 delete all / pm2 kill / pm2 restart all  <- would take down 12 live apps
 */
module.exports = {
  apps: [
    {
      name: 'k9-superapp-api',
      cwd: '/opt/k9-superapp/Backend',
      script: 'server.js',
      // fork, not cluster: the SP booking scheduler and the socket namespace are
      // singletons. Two workers would double every vendor alert.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      max_memory_restart: '600M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 5007
      },
      error_file: '/var/log/pm2/k9-superapp-api.error.log',
      out_file: '/var/log/pm2/k9-superapp-api.out.log',
      merge_logs: true,
      time: true
    }
  ]
};
