import assert from 'node:assert/strict';
import test from 'node:test';
import { caseInputRefs, downstreamView } from './correction-downstream-api';
const ref={snapshot_id:'s-old',product_id:'p-in',logical_key:'k',revision_id:'r1'},selection={planId:'plan',outputId:'out',requestId:'req'};
const packet=()=>({schema:'bd.output-publication-dependencies/1',...selection,outputSha256:'a'.repeat(64),coverage:'selected_request_output_only',rowAttribution:'unknown',fullDownstreamImpact:'unknown',
 publication:{status:'fixed_output_publication_verified',snapshotId:'s-published',productId:'p-out',datasetId:'dataset',records:[{snapshot_id:'s-published',product_id:'p-out',logical_key:'out-k',revision_id:'out-r'}]},
 inputObservations:{coverage:'selected_output_verified_parse_candidate_edges_only',downstreamImpact:'unknown',publishedProductQualification:'not_asserted',gaps:[],results:[{sourceRecordRef:ref,status:'observed',matches:[{sourceRecordRef:ref,parsedBusinessKey:'parsed',stepId:'step',specDigest:'b'.repeat(64),sourceArtifactSha256:'c'.repeat(64)}]}]}});
test('downstream projection requires exact published output and complete input reference observations',()=>{
 const p=packet(),v=downstreamView(p,selection,[ref]);assert.equal(v.inputs[0]!.status,'observed');assert.equal('matches' in v.inputs[0]!,false);
 for(const edit of [(p:any)=>p.requestId='other',(p:any)=>p.publication.status='candidate',(p:any)=>p.publication.records[0].snapshot_id='wrong',(p:any)=>p.inputObservations.results[0].sourceRecordRef={...ref,revision_id:'r2'},(p:any)=>p.inputObservations.results.push(p.inputObservations.results[0]),(p:any)=>p.inputObservations.results[0].matches[0].sourceRecordRef={...ref,logical_key:'another'},(p:any)=>p.rowAttribution='proven']){const bad=packet();edit(bad);assert.throws(()=>downstreamView(bad,selection,[ref]));}
 const absent:any=packet();absent.inputObservations.results[0]={sourceRecordRef:ref,status:'not_observed',matches:[]};assert.equal(downstreamView(absent,selection,[ref]).inputs[0]!.status,'not_observed');absent.inputObservations.gaps=['private raw gap'];assert.throws(()=>downstreamView(absent,selection,[ref]));absent.inputObservations.results[0].status='unknown';const unknown=downstreamView(absent,selection,[ref]);assert.equal(unknown.gapCount,1);assert.equal(JSON.stringify(unknown).includes('private raw gap'),false);
});
test('case comparison never truncates or invents case references',()=>{
 const detail:any={itemCount:1,records:[{snapshotId:ref.snapshot_id,productId:ref.product_id,businessKey:ref.logical_key,recordVersion:ref.revision_id}]};assert.deepEqual(caseInputRefs(detail),[ref]);assert.throws(()=>caseInputRefs({...detail,itemCount:2}));assert.throws(()=>caseInputRefs({...detail,itemCount:2,records:[...detail.records,...detail.records]}));assert.throws(()=>caseInputRefs({...detail,itemCount:129,records:Array(129).fill(detail.records[0])}));
});
