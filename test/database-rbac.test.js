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
const managerThird = '00000000-0000-4000-8000-000000000008';
const internThird = '00000000-0000-4000-8000-000000000009';
const firstProposal = '10000000-0000-4000-8000-000000000001';
const secondProposal = '10000000-0000-4000-8000-000000000002';
const researchProposal = '10000000-0000-4000-8000-000000000003';
const overBudgetProposal = '10000000-0000-4000-8000-000000000004';
const oversellProposal = '10000000-0000-4000-8000-000000000005';
const group1PendingProposal = '10000000-0000-4000-8000-000000000006';
const group2Proposal = '10000000-0000-4000-8000-000000000007';
const group3Proposal = '10000000-0000-4000-8000-000000000008';
const crossGroupReviewProposal = '10000000-0000-4000-8000-000000000009';
const crossGroupExecuteProposal = '10000000-0000-4000-8000-000000000010';

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
    const numberedGroupsMigration = await readFile(new URL('supabase/migrations/202610130001_numbered_club_groups.sql', root), 'utf8');
    await db.exec(numberedGroupsMigration);
    await db.exec(numberedGroupsMigration);

    async function asUser(userId, work) {
      await db.exec('set role authenticated');
      await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [userId]);
      try {
        return await work();
      } finally {
        await db.exec('reset role');
      }
    }

    const users = [owner, manager, internAssigned, internOther, quant, managerSecond, internResearch, managerThird, internThird];
    for (const [index, id] of users.entries()) {
      await db.query(
        'insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3::jsonb)',
        [id, `member${index + 1}@example.test`, JSON.stringify({ full_name: `Member ${index + 1}` })],
      );
    }
    await db.query(
      `insert into public.members(id,role) values($1,'owner'),($2,'manager'),($3,'intern'),($4,'intern'),($5,'quant'),($6,'manager'),($7,'intern'),($8,'manager'),($9,'intern')`,
      users,
    );

    // Reproduce a legacy cross-group assignment from before group validation.
    await db.query(`insert into public.club_team_managers(team_code,manager_id,assigned_by) values
      ('GROUP-1',$1,$3),('GROUP-2',$2,$3)`, [managerSecond, manager, owner]);
    await db.query(`insert into public.club_team_members(user_id,team_code,assigned_by) values($1,'GROUP-2',$2)`, [internOther, owner]);
    await db.query(`insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
      values($1,$2,$3)`, [internOther, managerSecond, owner]);
    const accessMigration = await readFile(new URL('supabase/migrations/202610140001_group_access_and_guest_limits.sql', root), 'utf8');
    await db.exec(accessMigration);
    await db.exec(accessMigration);
    const apiRolesMigration = await readFile(new URL('supabase/migrations/202610140002_market_budget_new_api_roles.sql', root), 'utf8');
    await db.exec(apiRolesMigration);
    await db.exec(apiRolesMigration);
    const deleteTeamsMigration = await readFile(new URL('supabase/migrations/202610150001_delete_empty_club_teams.sql', root), 'utf8');
    await db.exec(deleteTeamsMigration);
    await db.exec(deleteTeamsMigration);
    assert.deepEqual((await db.query(`select portfolio_owner_id,manager_id from public.portfolio_assignments
      where portfolio_owner_id=$1`, [internOther])).rows, [], 'migration removes a legacy cross-group assignment');
    assert.equal((await db.query(`select count(*)::int as count from public.audit_log
      where action='portfolio.assignment_removed_by_migration' and target_user_id=$1`, [internOther])).rows[0].count, 1);

    await asUser(owner, async () => {
      const { rows } = await db.query(`select team_code,team_name,active,member_count,manager_ids
        from public.list_admin_teams() where team_code like 'GROUP-%' order by team_code`);
      assert.deepEqual(rows, [
        { team_code: 'GROUP-1', team_name: 'Group #1', active: true, member_count: 0, manager_ids: [managerSecond] },
        { team_code: 'GROUP-2', team_name: 'Group #2', active: true, member_count: 1, manager_ids: [manager] },
        { team_code: 'GROUP-3', team_name: 'Group #3', active: true, member_count: 0, manager_ids: [] },
      ]);
      await db.query(`select public.save_club_team('GROUP-4','Group #4','Owner-created group')`);
      await assert.rejects(db.query(`select public.save_club_team('bad code','Bad','')`), /Group code must be/);
      await assert.rejects(db.query(`select public.delete_club_team('GROUP-2')`), /Remove all group members and Managers/);
      await db.query(`select public.delete_club_team('GROUP-4')`);
      assert.equal((await db.query(`select count(*)::int as count from public.club_teams where team_code='GROUP-4'`)).rows[0].count, 0);
      assert.equal((await db.query(`select count(*)::int as count from public.audit_log where action='team.deleted' and details->>'team_code'='GROUP-4'`)).rows[0].count, 1);
    });
    await assert.rejects(asUser(manager, () => db.query(`select public.delete_club_team('GROUP-1')`)), /Owner access required/);

    await db.query(`insert into public.proposals(id,author_id,symbol,side,quantity,thesis,risks) values
      ($1,$4,'AAPL','buy',10,'Long thesis with a durable catalyst and clear upside','Competition could invalidate the thesis'),
      ($2,$5,'MSFT','buy',2,'Long thesis with a durable catalyst and clear upside','Valuation could invalidate the thesis'),
      ($3,$6,'TSLA','buy',4,'Long thesis with a durable catalyst and clear upside','Valuation could invalidate the thesis')`,
    [firstProposal, secondProposal, researchProposal, internAssigned, internOther, internResearch]);

    await assert.rejects(asUser(owner, () => db.query(
      `select public.set_portfolio_coverage($1,'HTIG',array[$2]::uuid[])`, [internAssigned, manager],
    )), /assigned to this group/);
    await asUser(owner, async () => {
      await db.query(`select public.set_team_managers('HTIG',array[$1]::uuid[])`, [manager]);
      await db.query(`select public.set_team_managers('HTQF',array[$1]::uuid[])`, [manager]);
      await db.query(`select public.set_portfolio_coverage($1,'HTIG',array[$2]::uuid[])`, [internAssigned, manager]);
    });
    await asUser(manager, async () => {
      const { rows } = await db.query('select id from public.proposals order by id');
      assert.deepEqual(rows.map((row) => row.id), [firstProposal]);
      assert.equal((await db.query(`select public.has_permission('proposals.review') as allowed`)).rows[0].allowed, true);
      await db.query(`select public.review_proposal($1,'approved','Reviewed by assigned manager')`, [firstProposal]);
    });
    await asUser(internAssigned, async () => {
      const { rows } = await db.query(`select decision,comment,is_override from public.proposal_reviews where proposal_id=$1`, [firstProposal]);
      assert.deepEqual(rows, [{ decision: 'approved', comment: 'Reviewed by assigned manager', is_override: false }]);
    });
    await asUser(internOther, async () => {
      assert.deepEqual((await db.query(`select proposal_id from public.proposal_reviews`)).rows, []);
    });
    await db.query(`insert into public.proposals(id,author_id,symbol,side,quantity,thesis,risks) values
      ($1,$3,'NVDA','buy',10000,'A large position for a buying-power validation case','The full notional may exceed available cash'),
      ($2,$3,'TSLA','sell',1,'A sale proposal without an existing position','No shares are held in this symbol')`,
    [overBudgetProposal, oversellProposal, internAssigned]);
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
    await assert.rejects(asUser(manager, () => db.query(
      `select public.execute_proposal($1,100)`, [firstProposal],
    )), /approved, unexecuted proposal is required/);
    await asUser(internAssigned, async () => {
      const { rows } = await db.query('select symbol,quantity,price from public.trades');
      assert.deepEqual(rows, [{ symbol: 'AAPL', quantity: '10', price: '100' }]);
    });
    await asUser(owner, async () => {
      const { rows } = await db.query(`select count(*)::int as fills from public.trades where proposal_id=$1`, [firstProposal]);
      assert.equal(rows[0].fills, 1);
      const { rows: auditRows } = await db.query(`select target_user_id,details->>'proposal_id' as proposal_id
        from public.audit_log where action='paper_trade.executed' and details->>'proposal_id'=$1`, [firstProposal]);
      assert.deepEqual(auditRows, [{ target_user_id: internAssigned, proposal_id: firstProposal }]);
    });
    await asUser(manager, async () => {
      await db.query(`select public.review_proposal($1,'approved','')`, [overBudgetProposal]);
      await db.query(`select public.review_proposal($1,'approved','')`, [oversellProposal]);
      await assert.rejects(db.query(`select public.execute_proposal($1,10)`, [overBudgetProposal]), /does not have enough cash/);
      await assert.rejects(db.query(`select public.execute_proposal($1,10)`, [oversellProposal]), /does not hold enough shares/);
      const { rows } = await db.query(`select id,status from public.proposals
        where id=any(array[$1,$2]::uuid[]) order by id`, [overBudgetProposal, oversellProposal]);
      assert.deepEqual(rows, [
        { id: overBudgetProposal, status: 'approved' },
        { id: oversellProposal, status: 'approved' },
      ]);
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
      await db.query(`select public.save_club_team('GROUP-1','Group #1','Shared research group')`);
      await db.query(`select public.set_member_team($1,'GROUP-1')`, [internResearch]);
      await db.query(`select public.set_member_team($1,'GROUP-1')`, [quant]);
      await db.query(`select public.set_team_managers('GROUP-1',array[$1]::uuid[])`, [managerSecond]);
      await db.query(`select public.save_club_team('GROUP-2','Group #2','Second research group')`);
      await db.query(`select public.set_member_team($1,'GROUP-2')`, [internOther]);
      await db.query(`select public.set_team_managers('GROUP-2',array[$1]::uuid[])`, [manager]);
      await db.query(`select public.save_club_team('GROUP-3','Group #3','Third research group')`);
      await db.query(`select public.set_member_team($1,'GROUP-3')`, [internThird]);
      await db.query(`select public.set_team_managers('GROUP-3',array[$1]::uuid[])`, [managerThird]);
      const { rows } = await db.query(`select * from public.list_admin_teams() where team_code in ('GROUP-1','GROUP-2','GROUP-3') order by team_code`);
      assert.deepEqual(rows, [{
        team_code: 'GROUP-1', team_name: 'Group #1', description: 'Shared research group', active: true,
        member_count: 2, manager_ids: [managerSecond],
      }, {
        team_code: 'GROUP-2', team_name: 'Group #2', description: 'Second research group', active: true,
        member_count: 1, manager_ids: [manager],
      }, {
        team_code: 'GROUP-3', team_name: 'Group #3', description: 'Third research group', active: true,
        member_count: 1, manager_ids: [managerThird],
      }]);
    });
    await db.query(`insert into public.proposals(id,author_id,symbol,side,quantity,thesis,risks) values
      ($1,$4,'AAPL','buy',1,'Group one follow-up thesis with clear upside and a defined catalyst','Competition may weaken the opportunity'),
      ($2,$5,'NVDA','buy',1,'Group two thesis with a specific catalyst and measured allocation','Valuation could limit the expected return'),
      ($3,$6,'JPM','buy',1,'Group three thesis with a clear catalyst and bounded downside','Credit risk could invalidate the thesis'),
      ($7,$5,'MSFT','buy',1,'A pending Group two thesis with a measured position and clear catalyst','A weaker outlook would invalidate the investment'),
      ($8,$5,'AMZN','buy',1,'An approved Group two thesis with a measured position and clear catalyst','A weaker outlook would invalidate the investment')`,
    [group1PendingProposal, group2Proposal, group3Proposal, internResearch, internOther, internThird,
      crossGroupReviewProposal, crossGroupExecuteProposal]);
    await asUser(manager, async () => {
      await db.query(`select public.review_proposal($1,'approved','Approved inside Group #2')`, [crossGroupExecuteProposal]);
    });
    // Simulate an out-of-band stale assignment: runtime checks must still keep
    // access within the Manager's current group.
    await db.query(`insert into public.portfolio_assignments(portfolio_owner_id,manager_id,assigned_by)
      values($1,$2,$3)`, [internOther, managerSecond, owner]);
    await asUser(managerSecond, async () => {
      assert.deepEqual((await db.query('select id from public.proposals order by id')).rows, [
        { id: researchProposal },
        { id: group1PendingProposal },
      ]);
      assert.deepEqual((await db.query('select role,team from public.list_visible_portfolios() order by role')).rows, [
        { role: 'intern', team: 'GROUP-1' },
      ]);
      assert.deepEqual((await db.query(`select team_code,role from public.list_my_team_members() order by role`)).rows, [
        { team_code: 'GROUP-1', role: 'intern' },
        { team_code: 'GROUP-1', role: 'manager' },
        { team_code: 'GROUP-1', role: 'quant' },
      ]);
      await db.query(`select public.review_proposal($1,'approved','Group review')`, [researchProposal]);
      await db.query(`select public.execute_proposal($1,350)`, [researchProposal]);
      await db.query(`select public.review_proposal($1,'approved','Group one follow-up')`, [group1PendingProposal]);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [group2Proposal]), /outside your assigned portfolios/);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [group3Proposal]), /outside your assigned portfolios/);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Stale assignment')`, [crossGroupReviewProposal]), /outside your assigned portfolios/);
      await assert.rejects(db.query(`select public.execute_proposal($1,100)`, [crossGroupExecuteProposal]), /not assigned to you/);
      assert.deepEqual((await db.query(`select id from public.proposals where author_id=$1`, [internOther])).rows, []);
      assert.deepEqual((await db.query(`select id from public.trades where author_id=$1`, [internOther])).rows, []);
      assert.deepEqual((await db.query(`select user_id from public.club_team_members where user_id=$1`, [internOther])).rows, []);
      assert.deepEqual((await db.query(`select portfolio_owner_id from public.portfolio_assignments where portfolio_owner_id=$1`, [internOther])).rows, []);
      assert.deepEqual((await db.query(`select user_id from public.list_club_members() order by user_id`)).rows, [
        { user_id: managerSecond }, { user_id: internResearch },
      ]);
    });
    await assert.rejects(asUser(managerSecond, () => db.query(
      `select public.review_proposal($1,'rejected','Outside the assigned group')`, [firstProposal],
    )), /outside your assigned portfolios/);
    await asUser(manager, async () => {
      const { rows } = await db.query(
        `select id from public.proposals where id=any(array[$1,$2,$3,$4]::uuid[]) order by id`,
        [researchProposal, group1PendingProposal, group2Proposal, group3Proposal],
      );
      assert.deepEqual(rows, [{ id: group2Proposal }]);
      await db.query(`select public.review_proposal($1,'approved','Group two review')`, [group2Proposal]);
      await db.query(`select public.execute_proposal($1,50)`, [group2Proposal]);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [researchProposal]), /outside your assigned portfolios/);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [group3Proposal]), /outside your assigned portfolios/);
    });
    await asUser(managerSecond, async () => {
      assert.deepEqual((await db.query(`select id from public.trades where author_id=$1`, [internOther])).rows, []);
      assert.deepEqual((await db.query(`select id from public.proposals where author_id=$1`, [internOther])).rows, []);
    });
    await asUser(managerThird, async () => {
      assert.deepEqual((await db.query('select id from public.proposals order by id')).rows, [{ id: group3Proposal }]);
      assert.deepEqual((await db.query('select role,team from public.list_visible_portfolios() order by role')).rows, [
        { role: 'intern', team: 'GROUP-3' },
      ]);
      assert.deepEqual((await db.query(`select team_code,role from public.list_my_team_members() order by role`)).rows, [
        { team_code: 'GROUP-3', role: 'intern' },
        { team_code: 'GROUP-3', role: 'manager' },
      ]);
      await db.query(`select public.review_proposal($1,'approved','Group three review')`, [group3Proposal]);
      await db.query(`select public.execute_proposal($1,75)`, [group3Proposal]);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [researchProposal]), /outside your assigned portfolios/);
      await assert.rejects(db.query(`select public.review_proposal($1,'rejected','Cross-group review')`, [group2Proposal]), /outside your assigned portfolios/);
    });
    await asUser(internThird, async () => {
      await assert.rejects(db.query(`select public.set_member_role($1,'manager')`, [internThird]), /Owner access required/);
      await assert.rejects(db.query(`select public.review_proposal($1,'approved','Intern cannot approve')`, [group1PendingProposal]), /Proposal review permission required/);
      assert.deepEqual((await db.query('select symbol,quantity,price from public.trades')).rows, [{ symbol: 'JPM', quantity: '1', price: '75' }]);
      assert.equal((await db.query(`select 100000-sum(quantity*price) as cash from public.trades where author_id=$1`, [internThird])).rows[0].cash, '99925');
    });
    await assert.rejects(asUser(manager, () => db.query(
      `select public.save_club_team('OTHER','Other group','')`,
    )), /Owner access required/);
    await assert.rejects(asUser(manager, () => db.query(
      `select public.set_member_team($1,'GROUP-1')`, [internOther],
    )), /Owner access required/);

    await asUser(quant, async () => {
      assert.deepEqual((await db.query('select id from public.proposals order by id')).rows, [
        { id: researchProposal },
        { id: group1PendingProposal },
      ]);
      assert.deepEqual((await db.query('select symbol from public.trades order by symbol')).rows, [{ symbol: 'TSLA' }]);
      await assert.rejects(db.query(`select public.execute_proposal($1,50)`, [group1PendingProposal]), /Paper-trade execution permission required/);
      await assert.rejects(db.query(`select public.review_proposal($1,'approved','Quant cannot approve')`, [group1PendingProposal]), /Proposal review permission required/);
      await assert.rejects(db.query(`select public.set_member_role($1,'manager')`, [quant]), /Owner access required/);
      assert.deepEqual((await db.query('select role,team from public.list_visible_portfolios() order by role')).rows, [
        { role: 'intern', team: 'GROUP-1' },
        { role: 'quant', team: 'GROUP-1' },
      ]);
      assert.deepEqual((await db.query(`select team_code,role from public.list_my_team_members() order by role`)).rows, [
        { team_code: 'GROUP-1', role: 'intern' },
        { team_code: 'GROUP-1', role: 'manager' },
        { team_code: 'GROUP-1', role: 'quant' },
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
        team_code: 'GROUP-1', team_name: 'Group #1', manager_names: ['Member 6'],
      }]);
    });
    await assert.rejects(asUser(internAssigned, () => db.query(`select * from public.list_admin_teams()`)), /Owner access required/);
    await assert.rejects(asUser(internAssigned, () => db.query(`select public.save_club_team('GROUP-5','Group #5','')`)), /Owner access required/);
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
        `select action,target_user_id,details->>'proposal_id' as proposal_id from public.audit_log
          where action='paper_trade.executed' and details->>'proposal_id'=any(array[$1,$2,$3]::text[]) order by proposal_id`,
        [group2Proposal, group3Proposal, researchProposal],
      );
      assert.deepEqual(rows, [
        { action: 'paper_trade.executed', target_user_id: internResearch, proposal_id: researchProposal },
        { action: 'paper_trade.executed', target_user_id: internOther, proposal_id: group2Proposal },
        { action: 'paper_trade.executed', target_user_id: internThird, proposal_id: group3Proposal },
      ]);
    });

    await assert.rejects(asUser(manager, () => db.query(
      `select public.consume_market_request_budget(repeat('a',64),true,1,1,3)`,
    )), /permission denied/);
    await db.exec('set role service_role');
    await db.query(`select set_config('request.jwt.claim.role','',false)`);
    try {
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('c',64),true,0,1,3) as allowed`)).rows[0].allowed, true);
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('c',64),true,0,1,3) as allowed`)).rows[0].allowed, false);
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('c',64),false,0,1,3) as allowed`)).rows[0].allowed, true);
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('a',64),true,1,1,3) as allowed`)).rows[0].allowed, true);
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('a',64),true,1,1,3) as allowed`)).rows[0].allowed, false);
      assert.equal((await db.query(`select public.consume_market_request_budget(repeat('b',64),true,2,1,3) as allowed`)).rows[0].allowed, true);
      assert.equal((await db.query(`select public.consume_market_request_budget(null,false,1,1,3) as allowed`)).rows[0].allowed, false);
    } finally {
      await db.exec('reset role');
    }
    assert.equal((await db.query(`select request_count from public.market_request_limits where bucket_kind='global'`)).rows[0].request_count, 3);
  } finally {
    await db.close();
  }
});
