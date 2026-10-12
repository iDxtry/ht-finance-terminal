import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const manager = '00000000-0000-4000-8000-000000000002';
const internAssigned = '00000000-0000-4000-8000-000000000003';
const internOther = '00000000-0000-4000-8000-000000000004';
const quant = '00000000-0000-4000-8000-000000000005';
const managerSecond = '00000000-0000-4000-8000-000000000006';
const internResearch = '00000000-0000-4000-8000-000000000007';
const firstProposal = '10000000-0000-4000-8000-000000000001';
const secondProposal = '10000000-0000-4000-8000-000000000002';
const researchProposal = '10000000-0000-4000-8000-000000000003';

test('Supabase migration preserves Owner, Manager, Intern, and Quant permission boundaries', async () => {
  const db = new PGlite();
  const root = new URL('../', import.meta.url);
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text unique,
        email_confirmed_at timestamptz,
        raw_user_meta_data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      grant usage on schema public to anon, authenticated;
    `);
    await db.exec(await readFile(new URL('supabase/schema.sql', root), 'utf8'));
    const migration = await readFile(new URL('supabase/migrations/202610110001_owner_quant_rbac.sql', root), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const teamMigration = await readFile(new URL('supabase/migrations/202610120001_flexible_club_teams.sql', root), 'utf8');
    await db.exec(teamMigration);
    await db.exec(teamMigration);

    const users = [owner, manager, internAssigned, internOther, quant, managerSecond, internResearch];
    for (const [index, id] of users.entries()) {
      await db.query(
        'insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3::jsonb)',
        [id, `member${index + 1}@example.test`, JSON.stringify({ full_name: `Member ${index + 1}` })],
      );
    }
    await db.query(
      `insert into public.members(id,role) values($1,'owner'),($2,'manager'),($3,'intern'),($4,'intern'),($5,'quant'),($6,'manager'),($7,'intern')`,
      users,
    );
    await db.query(`insert into public.proposals(id,author_id,symbol,side,quantity,thesis,risks) values
      ($1,$4,'AAPL','buy',10,'Long thesis with a durable catalyst and clear upside','Competition could invalidate the thesis'),
      ($2,$5,'MSFT','buy',2,'Long thesis with a durable catalyst and clear upside','Valuation could invalidate the thesis'),
      ($3,$6,'TSLA','buy',4,'Long thesis with a durable catalyst and clear upside','Valuation could invalidate the thesis')`,
    [firstProposal, secondProposal, researchProposal, internAssigned, internOther, internResearch]);

    async function asUser(userId, work) {
      await db.exec('set role authenticated');
      await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [userId]);
      try {
        return await work();
      } finally {
        await db.exec('reset role');
      }
    }

    await asUser(owner, () => db.query(
      `select public.set_portfolio_coverage($1,'HTIG',array[$2]::uuid[])`, [internAssigned, manager],
    ));
    await asUser(manager, async () => {
      const { rows } = await db.query('select id from public.proposals order by id');
      assert.deepEqual(rows.map((row) => row.id), [firstProposal]);
      assert.equal((await db.query(`select public.has_permission('proposals.review') as allowed`)).rows[0].allowed, true);
      await db.query(`select public.review_proposal($1,'approved','Reviewed by assigned manager')`, [firstProposal]);
    });
    await assert.rejects(asUser(manager, () => db.query(
      `select public.review_proposal($1,'approved','')`, [secondProposal],
    )), /outside your assigned portfolios/);
    await assert.rejects(asUser(manager, () => db.query(
      `select public.set_member_role($1,'owner')`, [manager],
    )), /Owner access required/);
    await assert.rejects(asUser(owner, () => db.query(
      `select public.set_member_role($1,'manager')`, [owner],
    )), /at least one active Owner/);

    await asUser(manager, () => db.query(`select public.execute_proposal($1,100)`, [firstProposal]));
    await asUser(internAssigned, async () => {
      const { rows } = await db.query('select symbol,quantity,price from public.trades');
      assert.deepEqual(rows, [{ symbol: 'AAPL', quantity: '10', price: '100' }]);
    });
    await asUser(owner, () => db.query(
      `select public.set_portfolio_coverage($1,'HTQF',array[$2]::uuid[])`, [internOther, manager],
    ));
    await asUser(manager, () => db.query(
      `select public.review_proposal($1,'rejected','Risk is not acceptable')`, [secondProposal],
    ));
    await assert.rejects(asUser(manager, () => db.query(
      `select public.override_proposal($1,'approved','')`, [secondProposal],
    )), /Owner access required/);
    await asUser(owner, () => db.query(
      `select public.override_proposal($1,'approved','Owner review changes the risk decision')`, [secondProposal],
    ));
    await asUser(manager, () => db.query(`select public.execute_proposal($1,200)`, [secondProposal]));
    await assert.rejects(asUser(internAssigned, () => db.query(
      `select public.execute_proposal($1,100)`, [firstProposal],
    )), /Paper-trade execution permission required/);

    await asUser(owner, () => db.query(`select public.set_member_team($1,'HTQF')`, [quant]));
    await asUser(quant, async () => {
      assert.deepEqual((await db.query('select id from public.proposals order by id')).rows, [{ id: secondProposal }]);
      await assert.rejects(db.query(
        `select public.add_quant_analysis($1,'support','The risk-adjusted evidence supports further study. Model assumptions remain important.','{}'::jsonb)`,
        [firstProposal],
      ), /outside your assigned team/);
    });

    await asUser(owner, async () => {
      await db.query(`select public.save_club_team('Q-ALPHA','Quant Alpha','Shared research group')`);
      await db.query(`select public.set_member_team($1,'Q-ALPHA')`, [internResearch]);
      await db.query(`select public.set_member_team($1,'Q-ALPHA')`, [quant]);
      await db.query(`select public.set_team_managers('Q-ALPHA',array[$1,$2]::uuid[])`, [manager, managerSecond]);
      const { rows } = await db.query(`select * from public.list_admin_teams() where team_code='Q-ALPHA'`);
      assert.deepEqual(rows, [{
        team_code: 'Q-ALPHA', team_name: 'Quant Alpha', description: 'Shared research group', active: true,
        member_count: 2, manager_ids: [manager, managerSecond],
      }]);
    });
    await asUser(managerSecond, async () => {
      assert.deepEqual((await db.query('select id from public.proposals order by id')).rows, [{ id: researchProposal }]);
      assert.deepEqual((await db.query('select role,team from public.list_visible_portfolios() order by role')).rows, [
        { role: 'intern', team: 'Q-ALPHA' },
      ]);
      await db.query(`select public.review_proposal($1,'approved','Group review')`, [researchProposal]);
      await db.query(`select public.execute_proposal($1,350)`, [researchProposal]);
    });
    await assert.rejects(asUser(managerSecond, () => db.query(
      `select public.review_proposal($1,'rejected','Outside the assigned group')`, [firstProposal],
    )), /outside your assigned portfolios/);
    await assert.rejects(asUser(manager, () => db.query(
      `select public.save_club_team('OTHER','Other group','')`,
    )), /Owner access required/);
    await assert.rejects(asUser(manager, () => db.query(
      `select public.set_member_team($1,'Q-ALPHA')`, [internOther],
    )), /Owner access required/);

    await asUser(quant, async () => {
      assert.deepEqual((await db.query('select id from public.proposals')).rows, [{ id: researchProposal }]);
      assert.deepEqual((await db.query('select symbol from public.trades order by symbol')).rows, [{ symbol: 'TSLA' }]);
      assert.deepEqual((await db.query('select role,team from public.list_visible_portfolios() order by role')).rows, [
        { role: 'intern', team: 'Q-ALPHA' },
        { role: 'quant', team: 'Q-ALPHA' },
      ]);
      const participantIds = (await db.query('select user_id from public.list_proposal_authors()')).rows.map((row) => row.user_id);
      assert.ok(participantIds.includes(internResearch));
      await db.query(
        `select public.add_quant_analysis($1,'support','The risk-adjusted evidence supports further study. Model assumptions remain important.',$2::jsonb)`,
        [researchProposal, JSON.stringify({ max_drawdown_pct: 14 })],
      );
      assert.equal((await db.query('select recommendation from public.quant_analyses')).rows[0].recommendation, 'support');
      await assert.rejects(db.query(
        `select public.add_quant_analysis($1,'support','The risk-adjusted evidence supports further study. Model assumptions remain important.','{}'::jsonb)`,
        [firstProposal],
      ), /outside your assigned team/);
      assert.deepEqual((await db.query('select team_code,team_name,manager_names from public.my_team_details()')).rows, [{
        team_code: 'Q-ALPHA', team_name: 'Quant Alpha', manager_names: ['Member 2', 'Member 6'],
      }]);
    });
    await assert.rejects(asUser(internAssigned, () => db.query(`select * from public.list_admin_teams()`)), /Owner access required/);
    await asUser(internAssigned, async () => {
      assert.deepEqual((await db.query(`select * from public.my_team_details()`)).rows, [{
        team_code: 'HTIG', team_name: 'HTIG', manager_names: ['Member 2'],
      }]);
    });
    await asUser(internAssigned, async () => {
      await db.query(`insert into public.watchlists(user_id,symbols) values($1,array['AAPL','SPY'])`, [internAssigned]);
      await db.query(`update public.watchlists set symbols=array['AAPL','NVDA'] where user_id=$1`, [internAssigned]);
      assert.deepEqual((await db.query('select symbols from public.watchlists')).rows[0].symbols, ['AAPL', 'NVDA']);
    });
    await asUser(internOther, async () => {
      assert.deepEqual((await db.query('select symbols from public.watchlists')).rows, []);
    });
    await asUser(manager, async () => {
      assert.deepEqual((await db.query('select * from public.audit_log')).rows, []);
    });
    await asUser(owner, async () => {
      const { rows } = await db.query(
        `select action from public.audit_log where action in ('proposal.overridden','paper_trade.executed')`,
      );
      assert.ok(rows.length >= 3);
    });
  } finally {
    await db.close();
  }
});
