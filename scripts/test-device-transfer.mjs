import {pathToFileURL} from 'node:url';
import {deviceTransferScenario} from './device-transfer-scenario.mjs';
import {writeNightlyCaseResults} from './nightly-case-results.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_EVENT_NAME!=='schedule'||process.env.NIGHTLY_SUITE!=='s3rch-device-transfer'||process.env.GITHUB_WORKFLOW_REF!=='FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main')throw Error('Requires registered central nightly device transfer adapter');
let fixture,driver,status='blocked',cleanup='blocked';
try{
 const path=process.env.DEVICE_TRANSFER_FIXTURE_DRIVER;if(!path?.startsWith('/'))throw Error('Missing Infra fixture driver');
 driver=await import(pathToFileURL(path).href);fixture=await driver.setup();await driver.readiness(fixture);
 status='failed';await deviceTransferScenario(fixture);status='passed';
}catch{process.exitCode=1;}
finally{try{if(driver){await driver.teardown(fixture);cleanup='passed';}}catch{cleanup='failed';process.exitCode=1;}
 writeNightlyCaseResults({suite:'s3rch-device-transfer',expectedCases:['two-context-transfer','cleanup'],cases:[{name:'two-context-transfer',status},{name:'cleanup',status:cleanup}]});}
